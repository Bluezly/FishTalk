import { AudioPlayerStatus, VoiceConnectionStatus, EndBehaviorType, entersState, getVoiceConnection, createAudioPlayer } from '@discordjs/voice';
import prism from 'prism-media';
import { transcribeAudio, think, speak, stripEmotionTags, THINK_TIMEOUT_MS } from './ai.js';

const SILENCE_MS = 700;
const MIN_UTTERANCE_BYTES = 48000 * 2 * 2 * 0.4;
const BARGE_IN_BYTES = MIN_UTTERANCE_BYTES;
const MAX_UTTERANCE_MS = 30_000;
const ASR_TIMEOUT_MS = 20_000;
const MAX_QUEUE_LENGTH = 2;

export const sessions = new Map();

export function session(guildId) {
  if (!sessions.has(guildId)) {
    const player = createAudioPlayer();
    player.on('error', (err) => console.error('audio player error:', err));
    sessions.set(guildId, {
      connection: null,
      receiver: null,
      speakingHandler: null,
      disconnectHandler: null,
      player,
      history: [],
      listening: new Set(),
      activeStreams: new Map(),
      textChannelId: null,
      queue: [],
      processing: false,
      requestId: 0,
      ttsAbort: null,
      closed: false,
      lastReplyInterrupted: false,
    });
  }
  return sessions.get(guildId);
}

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function enqueue(state, task, kind = 'voice', onDrop = null) {
  if (state.closed) return false;

  if (state.queue.length >= MAX_QUEUE_LENGTH) {
    if (kind === 'voice') return false;

    const voiceIndex = state.queue.findIndex((item) => item.kind === 'voice');
    if (voiceIndex === -1) return false;

    const [dropped] = state.queue.splice(voiceIndex, 1);
    dropped.onDrop?.('request was replaced');
  }

  state.queue.push({ task, kind, onDrop });
  processQueue(state);
  return true;
}

async function processQueue(state) {
  if (state.processing) return;
  state.processing = true;

  try {
    while (state.queue.length && !state.closed) {
      const { task } = state.queue.shift();
      try {
        await task();
      } catch (err) {
        console.error('queued task failed:', err);
      }
    }
  } finally {
    state.processing = false;
  }
}

export function startListening(guild, connection) {
  const state = session(guild.id);
  state.closed = false;

  if (state.receiver && state.speakingHandler) {
    state.receiver.speaking.off('start', state.speakingHandler);
  }
  if (state.connection && state.disconnectHandler) {
    state.connection.off(VoiceConnectionStatus.Disconnected, state.disconnectHandler);
  }

  state.connection = connection;
  state.receiver = connection.receiver;

  const speakingHandler = (userId) => {
    const member = guild.members.cache.get(userId) ?? guild.voiceStates.cache.get(userId)?.member;
    if (!member || member.user.bot) return;
    if (state.listening.has(userId)) return;

    state.listening.add(userId);

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    state.activeStreams.set(userId, { opusStream, decoder });

    const chunks = [];
    let totalBytes = 0;
    let barged = false;
    let finalized = false;

    const cutoff = setTimeout(() => opusStream.destroy(), MAX_UTTERANCE_MS);

    const finish = async () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(cutoff);

      const active = state.activeStreams.get(userId);
      state.listening.delete(userId);
      state.activeStreams.delete(userId);

      if (active?.opusStream && !active.opusStream.destroyed) active.opusStream.destroy();
      if (active?.decoder && !active.decoder.destroyed) active.decoder.destroy();

      const pcm = Buffer.concat(chunks);
      if (pcm.length < MIN_UTTERANCE_BYTES || state.closed) return;

      enqueue(state, () => handleUtterance(guild, member, pcm), 'voice');
    };

    opusStream.pipe(decoder);

    decoder.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;

      if (!barged && totalBytes >= BARGE_IN_BYTES) {
        barged = true;
        state.requestId++;
        state.ttsAbort?.abort();
        if (state.player.state.status !== AudioPlayerStatus.Idle) {
          state.lastReplyInterrupted = true;
          state.player.stop(true);
        }
      }
    });

    decoder.once('end', finish);
    decoder.once('error', (err) => {
      console.error('opus decode error:', err);
      finish();
    });
    decoder.once('close', finish);
    opusStream.once('error', finish);
    opusStream.once('close', finish);
  };

  connection.receiver.speaking.on('start', speakingHandler);
  state.speakingHandler = speakingHandler;

  const disconnectHandler = async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      teardown(guild.id);
    }
  };

  connection.on(VoiceConnectionStatus.Disconnected, disconnectHandler);
  state.disconnectHandler = disconnectHandler;
}

export function teardown(guildId) {
  const connection = getVoiceConnection(guildId);
  const state = sessions.get(guildId);

  if (!state) {
    connection?.destroy();
    return;
  }

  state.closed = true;
  state.requestId++;
  state.ttsAbort?.abort();
  state.player.stop(true);

  const pendingTasks = state.queue.splice(0);
  for (const item of pendingTasks) {
    item.onDrop?.('assistant disconnected before processing the request');
  }

  for (const { opusStream, decoder } of state.activeStreams.values()) {
    if (!opusStream.destroyed) opusStream.destroy();
    if (!decoder.destroyed) decoder.destroy();
  }
  state.activeStreams.clear();
  state.listening.clear();

  connection?.destroy();
  sessions.delete(guildId);
}

function getTextChannel(guild, state) {
  if (!state.textChannelId) return null;
  const channel = guild.channels.cache.get(state.textChannelId);
  if (channel?.isTextBased?.() && 'send' in channel && typeof channel.send === 'function') {
    return channel;
  }
  return null;
}

export function isInBotsVoiceChannel(guild, member, state) {
  const botChannelId = state.connection?.joinConfig?.channelId;
  if (!botChannelId) return false;
  const userChannelId = guild.voiceStates.cache.get(member.id)?.channelId;
  return userChannelId === botChannelId;
}

async function handleUtterance(guild, member, pcm) {
  const state = session(guild.id);
  if (state.closed) return;

  const turnId = ++state.requestId;
  const t0 = Date.now();

  const text = await withTimeout(transcribeAudio(pcm), ASR_TIMEOUT_MS, 'speech recognition');
  const tAsr = Date.now();
  console.log(`[turn ${turnId}] ASR took ${tAsr - t0}ms -> "${text}"`);

  if (!text || state.closed || turnId !== state.requestId || sessions.get(guild.id) !== state) return;

  const channel = getTextChannel(guild, state);
  const transcriptMessage = `**${member.displayName}:** ${text}`.slice(0, 2000);
  channel?.send({ content: transcriptMessage, allowedMentions: { parse: [] } }).catch((err) => {
    console.error('failed to post transcript:', err);
  });

  try {
    const reply = await withTimeout(think(state, text, member.displayName, turnId), THINK_TIMEOUT_MS, 'thinking');
    const tThink = Date.now();
    console.log(`[turn ${turnId}] thinking took ${tThink - tAsr}ms`);
    if (state.closed || turnId !== state.requestId) return;

    channel
      ?.send({ content: `**assistant:** ${stripEmotionTags(reply)}`.slice(0, 2000), allowedMentions: { parse: [] } })
      .catch((err) => {
        console.error('failed to post assistant reply:', err);
      });
    await speak(guild, state, reply);
    console.log(`[turn ${turnId}] speaking took ${Date.now() - tThink}ms, total ${Date.now() - t0}ms`);
  } catch (err) {
    if (state.requestId === turnId) state.requestId++;
    console.error('utterance handling failed:', err);

    if (err?.status === 429 && !state.closed) {
      channel
        ?.send({ content: '**assistant:** _(hit the AI rate limit, try again in a bit)_', allowedMentions: { parse: [] } })
        .catch(() => {});
    }
  }
}