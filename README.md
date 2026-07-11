# Discord Voice Assistant

Voice bot for Discord built for the Fish Audio contest. Join a call, talk to it, and it replies out loud using Fish Audio TTS.

## Demo

https://github.com/Bluezly/FishTalk/raw/7205c84bdd5d202adcb19b9e3983779ba1b22ff9/demo/Demo.mp4

Used a TTS voice to talk to it in the video instead of my own mic — the bot just hears audio either way, doesn't matter where it comes from.

## How it works

- Join a voice channel and run `/join`
- Talk normally, it transcribes what you said (Groq Whisper by default, ElevenLabs also supported)
- The transcript goes to Gemini for a reply
- The reply gets spoken back with Fish Audio TTS
- Talk over it mid-reply and it stops and listens instead of talking over you
- Works with multiple people in the same call

You can also use `/ask` to type a question instead of talking.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in your keys in `.env`, then:

```bash
npm start
```

## Commands

| Command | What it does |
|---|---|
| `/join` | joins your voice channel |
| `/leave` | leaves the call |
| `/ask` | ask something by typing |

## Files

| File | What's in it |
|---|---|
| `index.js` | Discord client, slash commands |
| `voice.js` | listening, sessions, the request queue |
| `ai.js` | Gemini, transcription, Fish Audio TTS |
| `wav.js` | raw PCM to WAV for the transcription APIs |

## Stack

Fish Audio (TTS), Gemini (the actual conversation), Groq Whisper / ElevenLabs (speech to text), discord.js + @discordjs/voice (discord side of things).
