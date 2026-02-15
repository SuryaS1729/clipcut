/**
 * ═══════════════════════════════════════════════════════════════
 *  ClipCut — Telegram YouTube Clip Bot
 * ═══════════════════════════════════════════════════════════════
 *
 *  Send a YouTube link + timestamps → get back a trimmed clip.
 *
 *  Usage (in Telegram):
 *    "https://youtube.com/watch?v=abc  from 1:02 to 1:45"
 *    "Cut 20.50 to 21.30 https://youtu.be/abc"
 *
 *  Environment:
 *    BOT_TOKEN  — Telegram bot token from @BotFather
 *
 *  System requirements:
 *    • Node.js ≥ 18
 *    • yt-dlp   (in PATH)
 *    • ffmpeg   (in PATH)
 * ═══════════════════════════════════════════════════════════════
 */

const TelegramBot = require('node-telegram-bot-api');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
//  1. CONFIGURATION
// ─────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌  BOT_TOKEN environment variable is required.');
  console.error('   Run:  BOT_TOKEN=your_token_here node bot.js');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Temporary directory for downloads / cuts
const TMP_DIR = path.join(os.tmpdir(), 'clipcut');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Telegram file-size limits (in bytes)
const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50 MB

// ─────────────────────────────────────────────────────────────
//  2. IN-MEMORY STATE  (keyed by chatId)
// ─────────────────────────────────────────────────────────────

/**
 * pendingRequests[chatId] = {
 *   url:       "https://youtube.com/...",
 *   startTime: "00:20:50",   // HH:MM:SS
 *   endTime:   "00:21:30",
 * }
 */
const pendingRequests = {};

// ─────────────────────────────────────────────────────────────
//  3. YOUTUBE URL EXTRACTION
// ─────────────────────────────────────────────────────────────

/**
 * Extracts a YouTube URL from free-form text.
 * Supports youtube.com/watch, youtu.be/, youtube.com/shorts/, etc.
 */
function extractYouTubeUrl(text) {
  const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=[^\s&]+|shorts\/[^\s?]+|live\/[^\s?]+)|youtu\.be\/[^\s?]+)(?:[^\s]*)?/i;
  const match = text.match(regex);
  return match ? match[0] : null;
}

// ─────────────────────────────────────────────────────────────
//  4. TIMESTAMP PARSING
// ─────────────────────────────────────────────────────────────

/**
 * Normalises a single timestamp string to HH:MM:SS.
 *
 * Accepted inputs:
 *   "20.50"      → "00:20:50"
 *   "20:50"      → "00:20:50"
 *   "1:02:15"    → "01:02:15"
 *   "01:02:15"   → "01:02:15"
 *   "5"          → "00:00:05"
 *   "1.5"        → "00:01:05"
 */
function normaliseTimestamp(raw) {
  const trimmed = raw.trim();

  // Split on : or .
  const parts = trimmed.split(/[:.]/).map(Number);

  if (parts.some(isNaN)) return null;

  let hours = 0, minutes = 0, seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  } else {
    return null;
  }

  // Basic sanity checks
  if (seconds < 0 || seconds > 59 || minutes < 0 || minutes > 59 || hours < 0) {
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Extracts a pair of timestamps (start, end) from natural text.
 *
 * Looks for patterns like:
 *   "from 20.50 to 21.30"
 *   "20:50 to 21:30"
 *   "1:02:15 - 1:03:00"
 *   "cut 20.50 to 21.30"
 */
function extractTimestamps(text) {
  // Match timestamps: digits separated by : or . (1-3 groups)
  // e.g. "20.50", "1:02:15", "21:30"
  const tsPattern = /(\d{1,2}(?:[:.]\d{1,2}){1,2})/g;
  const matches = text.match(tsPattern);

  if (!matches || matches.length < 2) return null;

  // Take the first two timestamps found
  const start = normaliseTimestamp(matches[0]);
  const end = normaliseTimestamp(matches[1]);

  if (!start || !end) return null;

  return { startTime: start, endTime: end };
}

/**
 * Converts HH:MM:SS to total seconds for comparison.
 */
function toSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// ─────────────────────────────────────────────────────────────
//  5. HELPER: run a command as a promise
// ─────────────────────────────────────────────────────────────

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  6. DOWNLOAD + CUT + SEND PIPELINE
// ─────────────────────────────────────────────────────────────

/**
 * Downloads the relevant stream, cuts the segment, and sends it.
 *
 * @param {number} chatId
 * @param {string} url        YouTube URL
 * @param {string} startTime  HH:MM:SS
 * @param {string} endTime    HH:MM:SS
 * @param {string} mode       "audio" | "video"
 * @param {number} statusMsgId  Message to edit with progress
 */
async function processClip(chatId, url, startTime, endTime, mode, statusMsgId) {
  // Unique ID for filenames
  const uid = crypto.randomBytes(6).toString('hex');
  const isAudio = mode === 'audio';

  // File paths
  const ext = isAudio ? 'mp3' : 'mp4';
  const downloadPath = path.join(TMP_DIR, `${uid}_raw.${isAudio ? 'webm' : 'mp4'}`);
  const outputPath = path.join(TMP_DIR, `${uid}_clip.${ext}`);

  // Helper to update the status message
  const updateStatus = async (text) => {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: statusMsgId });
    } catch (_) {
      // Ignore edit errors (message unchanged, etc.)
    }
  };

  try {
    // ── Step 1: Download ──────────────────────────────
    await updateStatus('⬇️  Downloading from YouTube…');

    const ytdlpArgs = isAudio
      ? [
          '-f', 'bestaudio',
          '-o', downloadPath,
          '--no-playlist',
          '--no-warnings',
          url,
        ]
      : [
          '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
          '-o', downloadPath,
          '--merge-output-format', 'mp4',
          '--no-playlist',
          '--no-warnings',
          url,
        ];

    await runCommand('yt-dlp', ytdlpArgs);

    // yt-dlp may add an extension — find the actual file
    const actualDownload = findDownloadedFile(downloadPath);
    if (!actualDownload) {
      throw new Error('Download completed but file not found on disk.');
    }

    // ── Step 2: Cut ───────────────────────────────────
    await updateStatus('✂️  Cutting your clip…');

    const ffmpegArgs = [
      '-y',
      '-i', actualDownload,
      '-ss', startTime,
      '-to', endTime,
      '-c', 'copy',
    ];

    if (isAudio) {
      // Re-encode to MP3 for clean audio output
      ffmpegArgs.pop(); // remove 'copy'
      ffmpegArgs.pop(); // remove '-c'
      ffmpegArgs.push('-vn');            // no video
      ffmpegArgs.push('-acodec', 'libmp3lame');
      ffmpegArgs.push('-ab', '192k');
    }

    ffmpegArgs.push(outputPath);
    await runCommand('ffmpeg', ffmpegArgs);

    // ── Step 3: Check file size ───────────────────────
    const stats = fs.statSync(outputPath);
    if (stats.size > TELEGRAM_FILE_LIMIT) {
      await updateStatus(
        '⚠️  The clip is too large to send via Telegram (> 50 MB).\n' +
        'Try a shorter segment or choose audio-only for a smaller file.'
      );
      return;
    }

    if (stats.size === 0) {
      throw new Error('Output file is empty — the timestamps may be outside the video duration.');
    }

    // ── Step 4: Send ──────────────────────────────────
    await updateStatus('📤  Uploading your clip…');

    const duration = toSeconds(endTime) - toSeconds(startTime);

    if (isAudio) {
      await bot.sendAudio(chatId, outputPath, {
        caption: `🎵 Audio clip (${startTime} → ${endTime})`,
        duration: duration > 0 ? duration : undefined,
      });
    } else {
      await bot.sendVideo(chatId, outputPath, {
        caption: `🎬 Video clip (${startTime} → ${endTime})`,
        duration: duration > 0 ? duration : undefined,
        supports_streaming: true,
      });
    }

    await updateStatus('✅  Done! Enjoy your clip.');

  } catch (err) {
    console.error('Processing error:', err.message);

    let userMessage = '❌  Something went wrong while processing your clip.\n\n';

    if (err.message.includes('yt-dlp')) {
      userMessage += 'Could not download from YouTube. Please check that the link is valid and the video is publicly available.';
    } else if (err.message.includes('ffmpeg')) {
      userMessage += 'Failed to cut the clip. The timestamps might be outside the video duration.';
    } else {
      userMessage += `Error: ${err.message}`;
    }

    await updateStatus(userMessage);

  } finally {
    // ── Cleanup temp files ────────────────────────────
    cleanupFile(downloadPath);
    cleanupFile(outputPath);
    // Also clean any yt-dlp variant extensions
    cleanupGlob(path.join(TMP_DIR, `${uid}_raw.*`));
  }
}

/**
 * yt-dlp sometimes appends or changes the extension.
 * This finds the actual downloaded file.
 */
function findDownloadedFile(expectedPath) {
  if (fs.existsSync(expectedPath)) return expectedPath;

  // Try common variant extensions
  const dir = path.dirname(expectedPath);
  const base = path.basename(expectedPath, path.extname(expectedPath));

  const variants = ['.mp4', '.webm', '.mkv', '.m4a', '.opus', '.mp3', '.ogg'];
  for (const ext of variants) {
    const candidate = path.join(dir, base + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Safely deletes a file if it exists.
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) { /* ignore */ }
}

/**
 * Deletes all files matching a glob-like base prefix.
 */
function cleanupGlob(pattern) {
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern).replace(/\.\*$/, '');
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(prefix)) {
        cleanupFile(path.join(dir, file));
      }
    }
  } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────
//  7. TELEGRAM HANDLERS
// ─────────────────────────────────────────────────────────────

// ── 7a. Text messages ─────────────────────────────────────────

bot.on('message', async (msg) => {
  // Ignore non-text messages and callback queries
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Extract YouTube URL
  const url = extractYouTubeUrl(text);

  // Extract timestamps
  const timestamps = extractTimestamps(text);

  // ── Case 1: Both URL and timestamps present ──────────
  if (url && timestamps) {
    const { startTime, endTime } = timestamps;

    // Validate start < end
    if (toSeconds(startTime) >= toSeconds(endTime)) {
      await bot.sendMessage(chatId,
        '⚠️  The start time must be before the end time.\n\n' +
        `You sent: ${startTime} → ${endTime}\n\n` +
        'Please try again.'
      );
      return;
    }

    // Store the request
    pendingRequests[chatId] = { url, startTime, endTime };

    // Ask for format
    await bot.sendMessage(chatId,
      `🎯  Got it!\n\n` +
      `📎  ${url}\n` +
      `⏱  ${startTime} → ${endTime}\n\n` +
      `What format do you want?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🎵 Audio only', callback_data: 'format_audio' },
            { text: '🎬 Video clip', callback_data: 'format_video' },
          ]],
        },
      }
    );
    return;
  }

  // ── Case 2: URL present but no timestamps ────────────
  if (url && !timestamps) {
    await bot.sendMessage(chatId,
      '👍  I see the YouTube link!\n\n' +
      'Now please also include the **start** and **end** timestamps.\n\n' +
      'Examples:\n' +
      '• `from 1:20 to 2:45`\n' +
      '• `20.50 to 21.30`\n' +
      '• `0:00 to 0:30`\n\n' +
      'You can include everything in one message, like:\n' +
      '`https://youtube.com/... from 1:20 to 2:45`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Case 3: Timestamps present but no URL ────────────
  if (!url && timestamps) {
    await bot.sendMessage(chatId,
      '👍  I see the timestamps!\n\n' +
      'Please also include a **YouTube link** in your message.\n\n' +
      'Example:\n' +
      '`https://youtube.com/watch?v=... from 1:20 to 2:45`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Case 4: Neither — show help ──────────────────────
  // Only show help for messages that seem like they're trying to use the bot
  // (skip greetings, random chat, etc. — but since this is a bot, always reply)
  await bot.sendMessage(chatId,
    '👋  Hi! I\'m **ClipCut** — I cut clips from YouTube videos.\n\n' +
    '**How to use me:**\n' +
    'Send a message with a YouTube link and the start/end times.\n\n' +
    '**Examples:**\n' +
    '• `https://youtube.com/watch?v=abc from 1:20 to 2:45`\n' +
    '• `https://youtu.be/abc 20.50 to 21.30`\n' +
    '• `Please cut from 0:10 to 0:40 https://youtube.com/watch?v=abc`\n\n' +
    'I\'ll then ask if you want 🎵 audio or 🎬 video!',
    { parse_mode: 'Markdown' }
  );
});

// ── 7b. Inline button presses (format selection) ──────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Acknowledge the button press immediately
  await bot.answerCallbackQuery(query.id);

  // Check we have a pending request for this chat
  const request = pendingRequests[chatId];
  if (!request) {
    await bot.sendMessage(chatId,
      '⚠️  I don\'t have a pending request for you.\n\n' +
      'Please send a YouTube link with timestamps first.'
    );
    return;
  }

  // Determine mode
  let mode;
  if (data === 'format_audio') {
    mode = 'audio';
  } else if (data === 'format_video') {
    mode = 'video';
  } else {
    return; // Unknown callback, ignore
  }

  // Clear the pending request
  const { url, startTime, endTime } = request;
  delete pendingRequests[chatId];

  // Remove the inline keyboard from the format selection message
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    );
  } catch (_) { /* ignore */ }

  // Send a status message that we'll keep updating
  const statusMsg = await bot.sendMessage(chatId, '⏳  Processing your clip…');

  // Run the pipeline
  await processClip(chatId, url, startTime, endTime, mode, statusMsg.message_id);
});

// ── 7c. Polling errors ────────────────────────────────────────

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, '-', error.message);
});

// ─────────────────────────────────────────────────────────────
//  8. STARTUP
// ─────────────────────────────────────────────────────────────

console.log('🤖  ClipCut bot is running!');
console.log('    Send a YouTube link + timestamps in Telegram to get started.');
