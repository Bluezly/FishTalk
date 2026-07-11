import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState, getVoiceConnection } from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';

import { session, sessions, startListening, teardown, isInBotsVoiceChannel, enqueue, withTimeout } from './voice.js';
import { think, speak, stripEmotionTags, THINK_TIMEOUT_MS } from './ai.js';

if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;

const requiredEnv = ['DISCORD_TOKEN', 'FISH_API_KEY', 'GEMINI_API_KEY'];
if ((process.env.ASR_PROVIDER || 'groq').toLowerCase() === 'elevenlabs') {
  requiredEnv.push('ELEVENLABS_API_KEY');
} else {
  requiredEnv.push('GROQ_API_KEY');
}

for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error('missing required environment variable: ' + key);
}

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Brings the assistant into your voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnects the assistant'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription("Ask something by typing, in case you'd rather not talk")
    .addStringOption((o) => o.setName('question').setDescription('your question').setRequired(true)),
].map((c) => c.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

client.once('clientReady', async () => {
  console.log(`logged in as ${client.user.tag}`);
  console.log(`bot is currently in ${client.guilds.cache.size} guild(s):`);
  for (const [, guild] of client.guilds.cache) {
    console.log(`  - ${guild.name} (id: ${guild.id})`);
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const [, guild] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`registered ${commands.length} command(s) in ${guild.name} (id: ${guild.id})`);
    } catch (err) {
      console.error(`couldn't register commands in ${guild.name} (id: ${guild.id}):`, err.message);
    }
  }
  console.log('slash commands are live');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;

  try {
    if (commandName === 'join') {
      if (!member.voice.channel) {
        await interaction.reply('join a voice channel first, then run this again');
        return;
      }

      const existingState = sessions.get(guild.id);
      const currentChannelId = existingState?.connection?.joinConfig?.channelId;

      if (currentChannelId && currentChannelId !== member.voice.channel.id && !member.permissions.has('ManageGuild')) {
        await interaction.reply({
          content: "the assistant is already busy in another voice channel, ask someone with 'Manage Server' permission to move it",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const connection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connection.on('error', (err) => {
        console.error(`voice connection error in guild ${guild.id}:`, err);
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      } catch (err) {
        connection.destroy();
        throw err;
      }

      const state = session(guild.id);
      state.textChannelId = interaction.channelId;
      startListening(guild, connection);
      await interaction.reply(
        "in the channel and listening, talk whenever you're ready. raw audio isn't saved by this bot, it's sent to Fish Audio for transcription, the transcript gets posted in this channel, and the text goes to Gemini to generate a reply."
      );
      return;
    }

    if (commandName === 'leave') {
      const state = sessions.get(guild.id);
      if (state && !isInBotsVoiceChannel(guild, member, state)) {
        await interaction.reply({ content: 'join the same voice channel as the assistant first', flags: MessageFlags.Ephemeral });
        return;
      }
      teardown(guild.id);
      await interaction.reply('left the call');
      return;
    }

    if (commandName === 'ask') {
      const state = session(guild.id);
      if (!isInBotsVoiceChannel(guild, member, state)) {
        await interaction.reply({ content: 'join the same voice channel as the assistant first', flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply();
      const question = interaction.options.getString('question');

      const accepted = enqueue(
        state,
        async () => {
          const turnId = ++state.requestId;
          try {
            const reply = await withTimeout(think(state, question, member.displayName, turnId), THINK_TIMEOUT_MS, 'thinking');

            if (state.closed || turnId !== state.requestId) {
              await interaction
                .editReply(state.closed ? 'assistant disconnected before completing the request' : 'the request was interrupted by a newer conversation')
                .catch(() => {});
              return;
            }

            await interaction.editReply({
              embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(stripEmotionTags(reply).slice(0, 4096))],
              allowedMentions: { parse: [] },
            });

            if (state.connection && !state.closed) {
              await speak(guild, state, reply);
            }
          } catch (err) {
            if (state.requestId === turnId) state.requestId++;
            console.error('ask command failed:', err);
            await interaction.editReply(`something broke: ${err.message}`).catch(() => {});
          }
        },
        'ask',
        (reason) => {
          interaction.editReply(reason).catch(() => {});
        }
      );

      if (!accepted) {
        await interaction.editReply('the assistant is busy right now, try again in a moment');
      }
      return;
    }
  } catch (err) {
    console.error(err);
    const msg = `something broke: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);