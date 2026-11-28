import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { clearAIHistory, processWithAI } from './aiChat.js';
import { config } from './config.js';
import { downloadTaggedTrack, searchTracks } from './musicFinder.js';
import { buildPdfFromImages } from './pdfBuilder.js';
import {
  addReminder,
  clearUserReminders,
  formatMexicoDate,
  getUserReminders,
  startReminderLoop,
} from './reminders.js';
import { convertToSticker } from './stickerConverter.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();
const chatStates = new Map();
const botSentIds = new Set();
const sentMessagesStore = new Map();

// ===== PARCHE STICKERS CON AUDIO =====
const RAW_AUDIO_SYM = Symbol('rawAudioMsgBytes');
let encoderHooked = false;

function ensureStickerAudioEncoder() {
  if (encoderHooked) return;
  encoderHooked = true;
  const origEncode = proto.Message.StickerMessage.encode.bind(proto.Message.StickerMessage);
  proto.Message.StickerMessage.encode = (message, writer) => {
    const w = origEncode(message, writer);
    if (message && message[RAW_AUDIO_SYM]) {
      w.uint32(210).bytes(message[RAW_AUDIO_SYM]);
    }
    return w;
  };
}

async function extractOpusAudioFromVideo(videoBuffer, ext = 'mp4', maxSeconds = 5) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(os.tmpdir(), `aud-in-${id}.${ext}`);
  const outPath = path.join(os.tmpdir(), `aud-out-${id}.ogg`);
  try {
    await fs.promises.writeFile(inPath, videoBuffer);
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inPath,
    ]);
    if (!stdout.trim()) return null;

    await execFileAsync('ffmpeg', [
      '-y', '-i', inPath, '-t', String(Math.min(maxSeconds, 5)),
      '-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', outPath,
    ]);
    const oggBuffer = await fs.promises.readFile(outPath);
    return oggBuffer.length > 0 ? oggBuffer : null;
  } catch {
    return null;
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

async function sendSoundSticker(sock, jid, stickerBuffer, oggBuffer, quotedMsg) {
  ensureStickerAudioEncoder();
  const [preparedSticker, preparedAudio] = await Promise.all([
    prepareWAMessageMedia({ sticker: stickerBuffer }, { upload: sock.waUploadToServer }),
    prepareWAMessageMedia({ audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus' }, { upload: sock.waUploadToServer }),
  ]);

  const stickerMsg = preparedSticker.stickerMessage;
  stickerMsg[RAW_AUDIO_SYM] = proto.Message.AudioMessage.encode(preparedAudio.audioMessage).finish();

  const message = { stickerMessage: stickerMsg };
  if (quotedMsg) {
    message.stickerMessage.contextInfo = {
      stanzaId: quotedMsg.key.id,
      participant: quotedMsg.key.participant || quotedMsg.key.remoteJid,
      quotedMessage: quotedMsg.message,
    };
  }

  const msgId = `3EB0${randomBytes(10).toString('hex').toUpperCase()}`;
  await sock.relayMessage(jid, message, { messageId: msgId });
  return { key: { remoteJid: jid, fromMe: true, id: msgId }, message };
}
// =====================================

const SELF_JIDS_FILE = path.join('auth_info', 'self_jids.json');

function loadSavedSelfJids() {
  try {
    if (!fs.existsSync(SELF_JIDS_FILE)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(SELF_JIDS_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

const savedSelfJids = loadSavedSelfJids();

function saveSelfJid(jid) {
  savedSelfJids.add(jid);
  fs.mkdirSync('auth_info', { recursive: true });
  fs.writeFileSync(SELF_JIDS_FILE, JSON.stringify([...savedSelfJids], null, 2));
}

const sessions = {
  1: { folder: 'auth_info_1', qr: null, status: 'Iniciando...', sock: null },
  2: { folder: 'auth_info_2', qr: null, status: 'Iniciando...', sock: null },
};

let backgroundLoopsStarted = false;

function renderSlotHtml(num, s) {
  if (s.status === 'Conectado') {
    return `<div style="border:2px solid #4ade80;border-radius:12px;padding:20px;text-align:center;min-width:260px;"><h3>Dispositivo ${num}</h3><p style="color:#4ade80;font-weight:bold;">✅ Conectado</p></div>`;
  }
  if (!s.qr) {
    return `<div style="border:2px solid #555;border-radius:12px;padding:20px;text-align:center;min-width:260px;"><h3>Dispositivo ${num}</h3><p>⏳ ${s.status}</p></div>`;
  }
  return `<div style="border:2px solid #fff;border-radius:12px;padding:20px;text-align:center;background:#fff;color:#111;"><h3>Dispositivo ${num}</h3><div id="qr${num}"></div><script>new QRCode(document.getElementById("qr${num}"),{text:${JSON.stringify(s.qr)},width:250,height:250,correctLevel:QRCode.CorrectLevel.L});</script></div>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const bothConnected = sessions[1].status === 'Conectado' && sessions[2].status === 'Conectado';
  const refresh = bothConnected ? '' : '<meta http-equiv="refresh" content="10">';
  res.end(`<html><head>${refresh}<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="display:flex;flex-wrap:wrap;gap:24px;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:sans-serif;background:#111;color:#fff;">${renderSlotHtml(1, sessions[1])}${renderSlotHtml(2, sessions[2])}</body></html>`);
});

server.listen(process.env.PORT || 3000);

const URL_REGEX = /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\/[^\s]+/i;

function extractUrl(text) {
  const m = text.match(URL_REGEX);
  return m ? m[0] : null;
}

function sanitizePdfName(raw) {
  const clean = raw.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (clean || 'Tarea') + '.pdf';
}

const MENU_TEXT =
  'Esto es lo que puedo hacer por ti (en grupos usa *!* al inicio o responde a un mensaje mío):\n\n' +
  '⏰ *Recordatorios:* *"!recuérdame hoy a las 7pm..."* o *"!en 20 min..."*\n' +
  '🎬 *Videos y audios:* Pásame un link de X, TikTok, IG o YouTube (*!link*) y elige video, audio o sticker.\n' +
  '🎵 *Música con carátula:* *"!búscame [canción]"* y te la bajo en MP3 etiquetado.\n' +
  '📄 *Tareas en PDF:* *"!quiero hacer un pdf"*, manda tus fotos y al final dime *!listo*.\n' +
  '🖼️ *Stickers:* Mándame cualquier foto o video corto (en grupo pon *!* en el mensaje).\n' +
  '💬 *Plática libre:* Pregúntame o platícame lo que quieras.';

async function downloadTikTok(url, mode) {
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  const rawText = await res.text();
  if (!rawText) throw new Error('Respuesta vacía de TikWM');

  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error('TikWM no devolvió JSON válido');
  }

  if (json.code !== 0 || !json.data) throw new Error(json.msg || 'Error TikTok');
  const target = mode === 'audio' ? json.data.music : json.data.play;
  if (!target) throw new Error('Enlace de descarga vacío');

  const file = await fetch(target);
  if (!file.ok) throw new Error(`HTTP ${file.status}`);
  return { buffer: Buffer.from(await file.arrayBuffer()), ext: mode === 'audio' ? 'mp3' : 'mp4' };
}

async function downloadFromUrl(url, mode) {
  if (/tiktok\.com/i.test(url)) {
    try {
      return await downloadTikTok(url, mode);
    } catch {
      // Si TikWM falla o devuelve respuesta vacía, cae automáticamente a yt-dlp
    }
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (mode === 'audio') {
    const out = path.join(os.tmpdir(), `wsb-${id}.%(ext)s`);
    const final = path.join(os.tmpdir(), `wsb-${id}.mp3`);
    try {
      await execFileAsync(config.ytdlpPath, ['--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', out, url]);
      return { buffer: await fs.promises.readFile(final), ext: 'mp3' };
    } finally {
      await fs.promises.unlink(final).catch(() => {});
    }
  }

  const rawTemp = path.join(os.tmpdir(), `wsb-raw-${id}.mp4`);
  const finalTemp = path.join(os.tmpdir(), `wsb-${id}.mp4`);
  try {
    await execFileAsync(config.ytdlpPath, [
      '--no-playlist',
      '-f',
      'bv*[ext=mp4][filesize<45M]+ba[ext=m4a]/b[ext=mp4][filesize<45M]/b[ext=mp4]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      rawTemp,
      url,
    ]);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      rawTemp,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      finalTemp,
    ]);

    return { buffer: await fs.promises.readFile(finalTemp), ext: 'mp4' };
  } finally {
    await fs.promises.unlink(rawTemp).catch(() => {});
    await fs.promises.unlink(finalTemp).catch(() => {});
  }
}

function unwrapMessage(m) {
  let c = m;
  while (c) {
    if (c.ephemeralMessage?.message) c = c.ephemeralMessage.message;
    else if (c.viewOnceMessage?.message) c = c.viewOnceMessage.message;
    else if (c.viewOnceMessageV2?.message) c = c.viewOnceMessageV2.message;
    else break;
  }
  return c;
}

function extractText(c) {
  return (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '').trim();
}

function getContextInfo(c) {
  return (
    c.extendedTextMessage?.contextInfo ||
    c.imageMessage?.contextInfo ||
    c.videoMessage?.contextInfo ||
    c.documentMessage?.contextInfo ||
    null
  );
}

async function getGroupSubject(sock, jid) {
  if (groupSubjectCache.has(jid)) return groupSubjectCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    const s = meta?.subject || '';
    groupSubjectCache.set(jid, s);
    return s;
  } catch { return ''; }
}

async function react(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch {}
}

function detectMedia(c) {
  if (c.imageMessage) return { isAnimated: false, ext: 'jpg', isImage: true };
  if (c.videoMessage) return { isAnimated: true, ext: 'mp4', isImage: false };
  if (c.documentMessage) {
    const mime = c.documentMessage.mimetype || '';
    if (mime.startsWith('image/')) return { isAnimated: mime === 'image/gif', ext: mime === 'image/gif' ? 'gif' : 'png', isImage: true };
    if (mime.startsWith('video/')) return { isAnimated: true, ext: 'mp4', isImage: false };
  }
  return null;
}

async function sendSmartSticker(sock, jid, msg, stickerBuffer, sourceBuffer, isVideo, ext) {
  if (isVideo && sourceBuffer) {
    try {
      const ogg = await extractOpusAudioFromVideo(sourceBuffer, ext, config.maxVideoSeconds);
      if (ogg) {
        const sent = await sendSoundSticker(sock, jid, stickerBuffer, ogg, msg);
        if (sent?.key?.id) {
          botSentIds.add(sent.key.id);
          sentMessagesStore.set(sent.key.id, sent.message);
        }
        return;
      }
    } catch {}
  }
  await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
}

async function executeWAUrl(sock, jid, msg, url, action) {
  await react(sock, jid, msg.key, '⏳');
  try {
    if (action === 'video') {
      const { buffer } = await downloadFromUrl(url, 'video');
      await sock.sendMessage(jid, { video: buffer }, { quoted: msg });
    } else if (action === 'audio') {
      const { buffer } = await downloadFromUrl(url, 'audio');
      await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
    } else
