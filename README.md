# ClipCut 🎬✂️

A Telegram bot that cuts audio or video clips from YouTube videos based on timestamps.

Send a YouTube link + timestamps → choose audio or video → get your clip!

## Prerequisites

| Dependency | Install |
|---|---|
| **Node.js** ≥ 18 | [nodejs.org](https://nodejs.org) |
| **yt-dlp** | `brew install yt-dlp` or [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **ffmpeg** | `brew install ffmpeg` or [ffmpeg.org](https://ffmpeg.org) |

## Setup

### 1. Install dependencies

```bash
cd clipcut
npm install
```

### 2. Create a Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** you receive

### 3. Run the bot

```bash
BOT_TOKEN=your_token_here npm start
```

Or export the token first:

```bash
export BOT_TOKEN=your_token_here
npm start
```

## Usage

In Telegram, send your bot a message like:

```
https://www.youtube.com/watch?v=dQw4w9WgXcQ from 0:10 to 0:30
```

The bot will ask you to pick a format:

- 🎵 **Audio only** — sends an MP3
- 🎬 **Video clip** — sends an MP4

The clip is downloaded, cut, and sent right back to you!

### Supported timestamp formats

| Format | Example |
|---|---|
| `MM:SS` | `1:20 to 2:45` |
| `MM.SS` | `20.50 to 21.30` |
| `HH:MM:SS` | `1:02:15 to 1:03:00` |
| With text | `Please cut from 1:02 to 1:45` |

## Notes

- Telegram limits file uploads to **50 MB**. If a clip is too large, try a shorter segment or use audio-only.
- Temporary files are automatically cleaned up after each request.
- The bot uses polling mode — no webhook or public server needed.
