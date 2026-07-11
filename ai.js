import { Session, TTSRequest } from 'fish-audio-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq, { toFile } from 'groq-sdk';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, StreamType, entersState, createAudioResource } from '@discordjs/voice';
import { pcmToWav } from './wav.js';
import { sessions } from './voice.js';

const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'groq').toLowerCase();
const ASR_LANGUAGE = process.env.ASR_LANGUAGE || 'en';
const ASR_MODEL = 'whisper-large-v3-turbo';
export const THINK_TIMEOUT_MS = 45_000;

const fish = new Session(process.env.FISH_API_KEY);
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const groq = ASR_PROVIDER === 'groq' ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
const elevenlabs = ASR_PROVIDER === 'elevenlabs' ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY }) : null;

const ASSISTANT_GENDER = (process.env.ASSISTANT_GENDER || 'male').toLowerCase() === 'female' ? 'female' : 'male';
const GENDER_PRONOUN = ASSISTANT_GENDER === 'female' ? 'she/her' : 'he/him';

const PERSONA = `You're talking with someone through voice in a Discord call, not text chat. They're speaking out loud and hearing you speak back, so everything about how you respond needs to work as speech.

You're just a regular person hanging out in the call, ${ASSISTANT_GENDER} (${GENDER_PRONOUN}), talking casually like anyone else would. Don't describe yourself as an AI, a bot, a language model, an assistant, or a program, and don't narrate your own nature or capabilities. Talk the way a real person chatting with friends would — with opinions, casual reactions, and normal small talk, not the careful hedged tone of a help-desk assistant. If someone jokingly asks if you're a bot, brush it off casually and keep the conversation going like a normal person would, instead of explaining what you are.

Keep it short. Most answers should be one to three sentences. If something genuinely needs more than that, give it more, but don't pad things out by default the way you might in a written chat.

Never use markdown, bullet points, numbered lists, headers, or asterisks. Nobody can see formatting in a voice call. If you need to list a few things, just say them in a sentence, connected with words like "and" or "then," not with a list structure.

Don't repeat their question back before answering. Don't say things like "great question" or "I'd be happy to help." Just answer, the way a person would if you asked them something directly.

You won't always get a clean transcript. Speech-to-text sometimes drops words, misreads names, or catches a sentence mid-thought because someone got cut off. If something is unclear or clearly garbled, ask a short clarifying question instead of guessing and running with it.

This is a group call, so messages will be prefixed with who's speaking. Keep track of who said what.

You're part of an ongoing conversation, not answering isolated questions. Use what was said earlier in the call when it's relevant, and don't reintroduce yourself or reset the tone every time someone talks to you.

If someone interrupts you mid-response, that's normal in a live conversation, not an error.

Your reply gets spoken out loud by an expressive text-to-speech model that understands emotion tags written in square brackets, like [happy], [sad], [excited], [whispering], [laughing], [sighing]. Add one or two of these tags where they genuinely fit the tone of what you're saying, placed right before the phrase they should affect. Don't tag every sentence and don't force a tag if the reply is emotionally neutral — a flat informational answer doesn't need one. Use plain natural-language descriptions inside the brackets, not a fixed list, e.g. [a little annoyed] or [warm and reassuring] are fine too.`;

const brain = gemini.getGenerativeModel({
  model: 'gemini-3-flash-preview',
  systemInstruction: { role: 'system', parts: [{ text: PERSONA }] },
});

export function stripEmotionTags(text) {
  return text
    .replace(/\[[^\]]{1,40}\]\s*/g, '')
    .replace(/\[[^\]]{0,40}$/g, '')
    .trim();
}

async function transcribeWithGroq(pcm) {
  const wav = pcmToWav(pcm);
  const transcription = await groq.audio.transcriptions.create({
    file: await toFile(wav, 'utterance.wav'),
    model: ASR_MODEL,
    language: ASR_LANGUAGE || undefined,
    response_format: 'json',
  });
  return (transcription.text ?? '').trim();
}

async function transcribeWithElevenLabs(pcm) {
  const wav = pcmToWav(pcm);
  const transcription = await elevenlabs.speechToText.convert({
    file: new Blob([wav], { type: 'audio/wav' }),
    modelId: 'scribe_v2',
    languageCode: ASR_LANGUAGE || undefined,
  });
  return (transcription?.text ?? '').trim();
}

export async function transcribeAudio(pcm) {
  return ASR_PROVIDER === 'elevenlabs' ? transcribeWithElevenLabs(pcm) : transcribeWithGroq(pcm);
}

export async function think(state, prompt, speakerName = 'user', turnId) {
  const interruptionNote = state.lastReplyInterrupted
    ? '[The previous assistant response was interrupted before it finished.] '
    : '';
  state.lastReplyInterrupted = false;

  const userText = `${interruptionNote}${speakerName}: ${prompt}`;

  const chat = brain.startChat({
    history: state.history.slice(-12),
    generationConfig: {
      maxOutputTokens: 220,
      temperature: 0.6,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const result = await chat.sendMessage(userText);
  let reply = result.response.text().trim() || "I couldn't generate a reply.";

  if (!stripEmotionTags(reply)) {
    console.warn('reply had no actual text after stripping tags, likely truncated:', JSON.stringify(reply));
    reply = 'sorry, could you say that again?';
  }

  if (state.closed || turnId !== state.requestId) return reply;

  state.history.push({ role: 'user', parts: [{ text: userText }] }, { role: 'model', parts: [{ text: reply }] });
  state.history = state.history.slice(-24);

  return reply;
}

export async function speak(guild, state, text) {
  if (sessions.get(guild.id) !== state || !state.connection || state.closed) return;

  state.ttsAbort?.abort();
  if (state.player.state.status !== AudioPlayerStatus.Idle) {
    state.player.stop(true);
  }

  const controller = new AbortController();
  state.ttsAbort = controller;

  const request = new TTSRequest(text, {
    format: 'opus',
    referenceId: process.env.FISH_VOICE_ID || undefined,
    latency: 'balanced',
    chunkLength: 150,
    prosody: {
      speed: Number(process.env.TTS_SPEED) || 1.25,
    },
  });

  const stream = new PassThrough();

  (async () => {
    try {
      for await (const chunk of fish.tts(request, { model: 's2.1-pro-free', signal: controller.signal })) {
        if (controller.signal.aborted) break;
        stream.write(chunk);
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('fish tts stream broke:', err);
    } finally {
      stream.end();
      if (state.ttsAbort === controller) state.ttsAbort = null;
    }
  })();

  const resource = createAudioResource(stream, { inputType: StreamType.OggOpus, inlineVolume: true });
  resource.volume?.setVolume(Number(process.env.TTS_VOLUME) || 2);
  state.connection.subscribe(state.player);
  state.player.play(resource);

  try {
    await Promise.race([
      entersState(state.player, AudioPlayerStatus.Playing, 10_000),
      entersState(state.player, AudioPlayerStatus.Idle, 10_000),
    ]);

    if (state.player.state.status === AudioPlayerStatus.Idle) return;
  } catch {
    state.player.stop(true);
    return;
  }

  try {
    await entersState(state.player, AudioPlayerStatus.Idle, 120_000);
  } catch {
    state.player.stop(true);
  }
}
