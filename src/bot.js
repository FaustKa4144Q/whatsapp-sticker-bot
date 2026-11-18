import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from './config.js';
import { downloadTaggedTrack, searchTracks } from './musicFinder.js';
import { buildPdfFromImages } from './pdfBuilder.js';
import { convertToSticker } from './stickerConverter.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();
const pendingLinks = new Map();
const telegramLinks = new Map();
const pdfSessions = new Map();
const musicSearches = new Map();
const waitingMusicQuery = new Set();

let ultimoQR = null;
let estadoConexion = 'Iniciando bot...';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (estadoConexion === 'Conectado') {
    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#4ade80;text-align:center;"><h1>✅ ¡Bot conectado a WhatsApp!</h1></body></html>');
    return;
  }
  if (!ultimoQR) {
    res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;"><h2>⏳ Generando QR...</h2></body></html>');
    return;
  }
  res.end(`<html><head><meta http-equiv="refresh" content="15"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;background:#fff;color:#111;"><h2>Escanea este QR con WhatsApp</h2><div id="qrcode" style="padding:20px;border:4px solid #111;border-radius:12px;"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(ultimoQR)},width:320,height:320,correctLevel:QRCode.CorrectLevel.L});</script></body></html>`);
});

server.listen(process.env.PORT || 3000);

const SUPPORTED_URL_REGEX = /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\/[^\s]+/i;

function extractSupportedUrl(text) {
  const match = text.match(SUPPORTED_URL_REGEX);
  return match ? match[0] : null;
}

function sanitizeFilename(raw) {
  const clean = raw.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (clean || 'Tarea') + '.pdf';
}

async function downloadFromTikTok(url, mode) {
  const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  const json = await apiRes.json();
  if (json.code !== 0 || !json.data) throw new Error(json.msg || 'Error en TikTok');
  const targetUrl = mode === 'audio' ? json.data.music : json.data.play;
  if (!targetUrl) throw new Error('Sin enlace descargable');
  const fileRes = await fetch(targetUrl);
  if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), ext: mode === 'audio' ? 'mp3' : 'mp4' };
}

async function downloadMediaFromUrl(url, mode) {
  if (/tiktok\.com/i.test(url)) return await downloadFromTikTok(url, mode);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
  const temp = path.join(os.tmpdir(), `wsb-${id}.mp4`);
  try {
    await execFileAsync(config.ytdlpPath, ['--no-playlist', '-f', 'bv*[ext=mp4][vcodec^=avc1][filesize<45M]+ba[ext=m4a]/b[ext=mp4][filesize<45M]/b[ext=mp4]/b', '--merge-output-format', 'mp4', '-o', temp, url]);
    return { buffer: await fs.promises.readFile(temp), ext: 'mp4' };
  } finally {
    await fs.promises.unlink(temp).catch(() => {});
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

async function getGroupSubject(sock, jid) {
  if (groupSubjectCache.has(jid)) return groupSubjectCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
    const s = meta?.subject || '';
    groupSubjectCache.set(jid, s);
    return s;
  } catch { return ''; }
}

async function isAuthorizedChat(sock, jid) {
  if (!jid || jid === 'status@broadcast') return false;
  if (jid.endsWith('@g.us')) {
    if (config.allowedGroupJids.includes(jid)) return true;
    if (config.allowedGroupNames.length > 0) return config.allowedGroupNames.includes(await getGroupSubject(sock, jid));
    return false;
  }
  return config.allowedUserJids.includes(jid);
}

async function react(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); } catch {}
}

function detectDirectMedia(c) {
  if (c.imageMessage) return { isAnimated: false, ext: 'jpg', isImage: true };
  if (c.videoMessage) return { isAnimated: true, ext: 'mp4', isImage: false };
  if (c.documentMessage) {
    const mime = c.documentMessage.mimetype || '';
    if (mime.startsWith('image/')) return { isAnimated: mime === 'image/gif', ext: mime === 'image/gif' ? 'gif' : 'png', isImage: true };
    if (mime.startsWith('video/')) return { isAnimated: true, ext: 'mp4', isImage: false };
  }
  return null;
}

async function processWAUrl(sock, jid, msg, url, action) {
  await react(sock, jid, msg.key, '⏳');
  try {
    if (action === 'video') {
      const { buffer } = await downloadMediaFromUrl(url, 'video');
      await sock.sendMessage(jid, { video: buffer }, { quoted: msg });
    } else if (action === 'audio') {
      const { buffer } = await downloadMediaFromUrl(url, 'audio');
      await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
    } else {
      const { buffer, ext } = await downloadMediaFromUrl(url, 'sticker');
      const sticker = await convertToSticker(buffer, { isAnimated: true, ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
    }
    await react(sock, jid, msg.key, '✅');
  } catch (err) {
    await react(sock, jid, msg.key, '❌');
    await sock.sendMessage(jid, { text: `Error: ${err.message}` }, { quoted: msg });
  }
}

async function handleWAMusicSearch(sock, jid, msg, query) {
  await react(sock, jid, msg.key, '🔍');
  try {
    const tracks = await searchTracks(query);
    if (tracks.length === 0) {
      await sock.sendMessage(jid, { text: '❌ No encontré esa canción.' }, { quoted: msg });
      return;
    }
    musicSearches.set(jid, tracks);
    const list = tracks.map((t, i) => `${i + 1}️⃣ *${t.title}* - ${t.artist}\n   💿 _${t.album}_`).join('\n\n');
    await sock.sendMessage(jid, { text: `🎵 *Resultados para "${query}":*\n\n${list}\n\nResponde con el número (*1* al *${tracks.length}*) para descargar con carátula.` }, { quoted: msg });
  } catch (err) {
    await sock.sendMessage(jid, { text: `Error buscando: ${err.message}` }, { quoted: msg });
  }
}

async function handleWAMessage(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const c = unwrapMessage(msg.message);
  if (!c) return;
  if (msg.key.fromMe && (c.stickerMessage || c.videoMessage || c.audioMessage || c.documentMessage)) return;

  const text = extractText(c);
  if (text === '!id' && jid.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: `JID:\n${jid}` }, { quoted: msg });
    return;
  }

  if (!(msg.key.fromMe || (await isAuthorizedChat(sock, jid)))) return;

  // --- MODO MÚSICA EN WHATSAPP ---
  if (/^!musica\b/i.test(text)) {
    const query = text.replace(/^!musica\s*/i, '').trim();
    if (!query) {
      waitingMusicQuery.add(jid);
      await sock.sendMessage(jid, { text: '🎵 *Modo Música activado*\nEscribe el nombre de la canción (y el artista si quieres):' }, { quoted: msg });
      return;
    }
    waitingMusicQuery.delete(jid);
    await handleWAMusicSearch(sock, jid, msg, query);
    return;
  }

  if (waitingMusicQuery.has(jid) && text && !text.startsWith('!')) {
    waitingMusicQuery.delete(jid);
    await handleWAMusicSearch(sock, jid, msg, text);
    return;
  }

  if (/^[1-5]$/.test(text) && musicSearches.has(jid)) {
    const tracks = musicSearches.get(jid);
    const idx = Number(text) - 1;
    if (tracks[idx]) {
      musicSearches.delete(jid);
      await react(sock, jid, msg.key, '⏳');
      try {
        const { buffer, filename } = await downloadTaggedTrack(tracks[idx]);
        await sock.sendMessage(jid, { document: buffer, mimetype: 'audio/mpeg', fileName: filename }, { quoted: msg });
        await react(sock, jid, msg.key, '✅');
      } catch (err) {
        await react(sock, jid, msg.key, '❌');
        await sock.sendMessage(jid, { text: `Error descargando canción: ${err.message}` }, { quoted: msg });
      }
      return;
    }
  }
  // --- FIN MODO MÚSICA ---

  // --- MODO PDF EN WHATSAPP ---
  if (/^!pdf\b/i.test(text)) {
    const rawName = text.replace(/^!pdf\s*/i, '').trim();
    const filename = sanitizeFilename(rawName);
    pdfSessions.set(jid, { filename, buffers: [] });
    await sock.sendMessage(jid, { text: `📄 *Modo PDF activado* (${filename})\n\nManda todas las fotos de tu tarea (en orden). Cuando termines escribe *!listo* (o *!cancelar*).` }, { quoted: msg });
    return;
  }

  if (/^!cancelar$/i.test(text) && pdfSessions.has(jid)) {
    pdfSessions.delete(jid);
    await sock.sendMessage(jid, { text: '❌ Creación de PDF cancelada.' }, { quoted: msg });
    return;
  }

  if (/^!listo$/i.test(text) && pdfSessions.has(jid)) {
    const session = pdfSessions.get(jid);
    pdfSessions.delete(jid);
    if (session.buffers.length === 0) {
      await sock.sendMessage(jid, { text: '⚠️ No mandaste ninguna foto.' }, { quoted: msg });
      return;
    }
    await react(sock, jid, msg.key, '⏳');
    try {
      const pdfBuffer = await buildPdfFromImages(session.buffers);
      await sock.sendMessage(jid, { document: pdfBuffer, mimetype: 'application/pdf', fileName: session.filename }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
    } catch (err) {
      await react(sock, jid, msg.key, '❌');
      await sock.sendMessage(jid, { text: `Error creando PDF: ${err.message}` }, { quoted: msg });
    }
    return;
  }

  const media = detectDirectMedia(c);
  if (media && media.isImage && pdfSessions.has(jid)) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      pdfSessions.get(jid).buffers.push(buffer);
      await react(sock, jid, msg.key, '📄');
    } catch {
      await react(sock, jid, msg.key, '❌');
    }
    return;
  }
  // --- FIN MODO PDF ---

  if (/^[123]$/.test(text) && pendingLinks.has(jid)) {
    const { url } = pendingLinks.get(jid);
    pendingLinks.delete(jid);
    await processWAUrl(sock, jid, msg, url, { '1': 'video', '2': 'audio', '3': 'sticker' }[text]);
    return;
  }

  const url = extractSupportedUrl(text);
  if (url) {
    if (/^!video\b/i.test(text)) return await processWAUrl(sock, jid, msg, url, 'video');
    if (/^!audio\b/i.test(text)) return await processWAUrl(sock, jid, msg, url, 'audio');
    if (/^!sticker\b/i.test(text)) return await processWAUrl(sock, jid, msg, url, 'sticker');

    pendingLinks.set(jid, { url });
    await sock.sendMessage(jid, { text: '¿Qué quieres hacer?\n\n1️⃣ Video (MP4)\n2️⃣ Solo audio (MP3)\n3️⃣ Sticker\n\nResponde *1*, *2* o *3*' }, { quoted: msg });
    return;
  }

  if (media) {
    await react(sock, jid, msg.key, '⏳');
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const sticker = await convertToSticker(buffer, { isAnimated: media.isAnimated, ext: media.ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
    } catch (err) {
      await react(sock, jid, msg.key, '❌');
      await sock.sendMessage(jid, { text: `Error: ${err.message}` }, { quoted: msg });
    }
  }
}

async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendFile(token, method, chatId, field, buffer, filename, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(field, new Blob([buffer]), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  return (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form })).json();
}

async function tgDownloadPhoto(token, fileId) {
  const info = await tgApi(token, 'getFile', { file_id: fileId });
  const fileUrl = `https://api.telegram.org/file/bot${token}/${info.result.file_path}`;
  const res = await fetch(fileUrl);
  return Buffer.from(await res.arrayBuffer());
}

async function handleTGMusicSearch(token, chatId, msgId, query) {
  const tracks = await searchTracks(query);
  if (tracks.length === 0) {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: '❌ No encontré esa canción.' });
    return;
  }
  const searchId = Math.random().toString(36).slice(2, 8);
  musicSearches.set(searchId, tracks);
  const buttons = tracks.map((t, i) => [{ text: `🎵 ${t.title} - ${t.artist}`, callback_data: `song:${searchId}:${i}` }]);
  await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: `Elige la canción que quieres descargar:`,
    reply_to_message_id: msgId,
    reply_markup: { inline_keyboard: buttons },
  });
}

async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  let offset = 0;
  while (true) {
    try {
      const data = await tgApi(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (!data.ok) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      for (const u of data.result) {
        offset = u.update_id + 1;
        if (u.message) {
          const chatId = String(u.message.chat.id);
          const text = (u.message.text || u.message.caption || '').trim();

          if (/^\/musica\b|^!musica\b/i.test(text)) {
            const query = text.replace(/^(\/musica|!musica)\s*/i, '').trim();
            if (!query) {
              waitingMusicQuery.add(chatId);
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: '🎵 Escribe el nombre de la canción:' });
            } else {
              waitingMusicQuery.delete(chatId);
              await handleTGMusicSearch(token, chatId, u.message.message_id, query);
            }
            continue;
          }

          if (waitingMusicQuery.has(chatId) && text && !text.startsWith('/') && !text.startsWith('!')) {
            waitingMusicQuery.delete(chatId);
            await handleTGMusicSearch(token, chatId, u.message.message_id, text);
            continue;
          }

          if (/^\/pdf\b|^!pdf\b/i.test(text)) {
            const rawName = text.replace(/^(\/pdf|!pdf)\s*/i, '').trim();
            const filename = sanitizeFilename(rawName);
            pdfSessions.set(chatId, { filename, buffers: [] });
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: `📄 Modo PDF activado (${filename}). Manda tus fotos y cuando termines escribe /listo` });
            continue;
          }

          if (/^\/listo$|^!listo$/i.test(text) && pdfSessions.has(chatId)) {
            const session = pdfSessions.get(chatId);
            pdfSessions.delete(chatId);
            if (session.buffers.length === 0) {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⚠️ No mandaste ninguna foto.' });
              continue;
            }
            const waitMsg = await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⏳ Armando PDF...' });
            try {
              const pdfBuffer = await buildPdfFromImages(session.buffers);
              await tgSendFile(token, 'sendDocument', chatId, 'document', pdfBuffer, session.filename);
              await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: waitMsg.result.message_id });
            } catch (err) {
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: waitMsg.result.message_id, text: `❌ Error: ${err.message}` });
            }
            continue;
          }

          if (u.message.photo && pdfSessions.has(chatId)) {
            const bestPhoto = u.message.photo[u.message.photo.length - 1];
            const buf = await tgDownloadPhoto(token, bestPhoto.file_id);
            pdfSessions.get(chatId).buffers.push(buf);
            continue;
          }

          const url = extractSupportedUrl(text);
          if (url) {
            const id = Math.random().toString(36).slice(2, 9);
            telegramLinks.set(id, url);
            await tgApi(token, 'sendMessage', {
              chat_id: chatId,
              text: '¿Qué quieres hacer con este enlace?',
              reply_to_message_id: u.message.message_id,
              reply_markup: { inline_keyboard: [[{ text: '🎬 Video', callback_data: `video:${id}` }, { text: '🎵 Audio', callback_data: `audio:${id}` }], [{ text: '🖼️ Sticker', callback_data: `sticker:${id}` }]] },
            });
          }
        }
        if (u.callback_query) {
          const cb = u.callback_query;
          const parts = (cb.data || '').split(':');
          await tgApi(token, 'answerCallbackQuery', { callback_query_id: cb.id });

          if (parts[0] === 'song') {
            const tracks = musicSearches.get(parts[1]);
            const track = tracks?.[Number(parts[2])];
            if (!track) {
              await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: '⚠️ Búsqueda caducada.' });
              continue;
            }
            musicSearches.delete(parts[1]);
            await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `⏳ Descargando "${track.title}" con carátula...` });
            try {
              const { buffer, filename } = await downloadTaggedTrack(track);
              await tgSendFile(token, 'sendAudio', cb.message.chat.id, 'audio', buffer, filename, { title: track.title, performer: track.artist });
              await tgApi(token, 'deleteMessage', { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
            } catch (err) {
              await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `❌ Error: ${err.message}` });
            }
            continue;
          }

          const [action, id] = parts;
          const url = telegramLinks.get(id);
          if (!url) {
            await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: '⚠️ Enlace caducado.' });
            continue;
          }
          telegramLinks.delete(id);
          await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `⏳ Procesando ${action}...` });
          try {
            if (action === 'video') {
              const { buffer } = await downloadMediaFromUrl(url, 'video');
              await tgSendFile(token, 'sendVideo', cb.message.chat.id, 'video', buffer, 'video.mp4');
            } else if (action === 'audio') {
              const { buffer } = await downloadMediaFromUrl(url, 'audio');
              await tgSendFile(token, 'sendAudio', cb.message.chat.id, 'audio', buffer, 'audio.mp3');
            } else {
              const { buffer, ext } = await downloadMediaFromUrl(url, 'sticker');
              const sticker = await convertToSticker(buffer, { isAnimated: true, ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
              await tgSendFile(token, 'sendSticker', cb.message.chat.id, 'sticker', sticker, 'sticker.webp');
            }
            await tgApi(token, 'deleteMessage', { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
          } catch (err) {
            await tgApi(token, 'editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: `❌ Error: ${err.message}` });
          }
        }
      }
    } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
}

export async function startBot() {
  startTelegramBot();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger, auth: state, printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '20.0.04'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { ultimoQR = qr; estadoConexion = 'Esperando QR'; }
    if (connection === 'close') {
      estadoConexion = 'Reconectando...';
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(() => startBot(), 3000);
    } else if (connection === 'open') {
      ultimoQR = null;
      estadoConexion = 'Conectado';
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) await handleWAMessage(sock, msg);
  });
}