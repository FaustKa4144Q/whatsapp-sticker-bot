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
import { askAI, clearAIHistory } from './aiChat.js';
import { config } from './config.js';
import { downloadTaggedTrack, searchTracks } from './musicFinder.js';
import { buildPdfFromImages } from './pdfBuilder.js';
import { convertToSticker } from './stickerConverter.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();
const chatStates = new Map();

let ultimoQR = null;
let estadoConexion = 'Iniciando bot...';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (estadoConexion === 'Conectado') {
    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#4ade80;"><h1>✅ Bot conectado a WhatsApp</h1></body></html>');
    return;
  }
  if (!ultimoQR) {
    res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;"><h2>⏳ Generando QR...</h2></body></html>');
    return;
  }
  res.end(`<html><head><meta http-equiv="refresh" content="15"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;background:#fff;color:#111;"><h2>Escanea este QR</h2><div id="qrcode" style="padding:20px;border:4px solid #111;border-radius:12px;"></div><script>new QRCode(document.getElementById("qrcode"),{text:${JSON.stringify(ultimoQR)},width:320,height:320,correctLevel:QRCode.CorrectLevel.L});</script></body></html>`);
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

async function downloadTikTok(url, mode) {
  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) throw new Error(json.msg || 'Error TikTok');
  const target = mode === 'audio' ? json.data.music : json.data.play;
  const file = await fetch(target);
  if (!file.ok) throw new Error(`HTTP ${file.status}`);
  return { buffer: Buffer.from(await file.arrayBuffer()), ext: mode === 'audio' ? 'mp3' : 'mp4' };
}

async function downloadFromUrl(url, mode) {
  if (/tiktok\.com/i.test(url)) return await downloadTikTok(url, mode);
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

async function isAuthorized(sock, jid) {
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

async function executeWAUrl(sock, jid, msg, url, action) {
  await react(sock, jid, msg.key, '⏳');
  try {
    if (action === 'video') {
      const { buffer } = await downloadFromUrl(url, 'video');
      await sock.sendMessage(jid, { video: buffer }, { quoted: msg });
    } else if (action === 'audio') {
      const { buffer } = await downloadFromUrl(url, 'audio');
      await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg' }, { quoted: msg });
    } else {
      const { buffer, ext } = await downloadFromUrl(url, 'sticker');
      const sticker = await convertToSticker(buffer, { isAnimated: true, ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
    }
    await react(sock, jid, msg.key, '✅');
  } catch (err) {
    await react(sock, jid, msg.key, '❌');
    await sock.sendMessage(jid, { text: `Error: ${err.message}` }, { quoted: msg });
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

  if (!(msg.key.fromMe || (await isAuthorized(sock, jid)))) return;

  if (/^!cancelar$/i.test(text)) {
    chatStates.delete(jid);
    clearAIHistory(jid);
    await sock.sendMessage(jid, { text: '🛑 Listo, operación cancelada.' }, { quoted: msg });
    return;
  }

  if (/^!menu$/i.test(text)) {
    chatStates.set(jid, { mode: 'MAIN_MENU' });
    await sock.sendMessage(jid, {
      text: '👋 *¿Qué vamos a hacer hoy?*\n\n' +
            '1️⃣ Descargar video / audio de enlace\n' +
            '2️⃣ Buscar música con carátula (MP3)\n' +
            '3️⃣ Armar PDF con fotos (Tarea)\n' +
            '4️⃣ Hacer sticker\n' +
            '5️⃣ Charlar con IA\n\n' +
            'Responde con un número (*1-5*) o escribe *!cancelar*.',
    }, { quoted: msg });
    return;
  }

  const state = chatStates.get(jid);

  // Modo charla con IA activo
  if (state?.mode === 'AI_CHAT' && text) {
    await react(sock, jid, msg.key, '🤖');
    try {
      const reply = await askAI(jid, text);
      await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    } catch (err) {
      await sock.sendMessage(jid, { text: `❌ Error IA: ${err.message}` }, { quoted: msg });
    }
    return;
  }

  const media = detectMedia(c);
  if (media) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });

    if (state?.mode === 'PDF_COLLECT' && media.isImage) {
      state.buffers.push(buffer);
      await react(sock, jid, msg.key, '📄');
      return;
    }

    if (state?.mode === 'WAIT_STICKER') {
      chatStates.delete(jid);
      await react(sock, jid, msg.key, '⏳');
      const sticker = await convertToSticker(buffer, { isAnimated: media.isAnimated, ext: media.ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
      return;
    }

    chatStates.set(jid, { mode: 'MEDIA_OPTIONS', media: { ...media, buffer } });
    const opts = media.isImage
      ? '1️⃣ Hacer sticker\n2️⃣ Iniciar PDF con esta foto\n\nResponde *1*, *2* o *!cancelar*'
      : '1️⃣ Hacer sticker animado\n\nResponde *1* o *!cancelar*';
    await sock.sendMessage(jid, { text: `¿Qué hacemos con esto?\n\n${opts}` }, { quoted: msg });
    return;
  }

  const url = extractUrl(text);
  if (url) {
    if (state?.mode === 'WAIT_STICKER') {
      chatStates.delete(jid);
      return await executeWAUrl(sock, jid, msg, url, 'sticker');
    }
    chatStates.set(jid, { mode: 'LINK_OPTIONS', url });
    await sock.sendMessage(jid, {
      text: '¿Qué hacemos con este enlace?\n\n1️⃣ Video (MP4)\n2️⃣ Solo audio (MP3)\n3️⃣ Sticker\n\nResponde *1*, *2*, *3* o *!cancelar*',
    }, { quoted: msg });
    return;
  }

  if (!state) return;

  if (state.mode === 'MAIN_MENU') {
    if (text === '1') {
      chatStates.set(jid, { mode: 'WAIT_LINK' });
      await sock.sendMessage(jid, { text: '🔗 Pega el enlace de X, TikTok, Instagram o YouTube:' }, { quoted: msg });
    } else if (text === '2') {
      chatStates.set(jid, { mode: 'WAIT_MUSIC' });
      await sock.sendMessage(jid, { text: '🎵 Escribe el nombre de la canción (y el artista):' }, { quoted: msg });
    } else if (text === '3') {
      chatStates.set(jid, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [] });
      await sock.sendMessage(jid, { text: '📄 *Modo PDF listo.*\nManda las fotos de tu tarea y cuando termines escribe *!listo* (o *!listo Nombre_Archivo*).' }, { quoted: msg });
    } else if (text === '4') {
      chatStates.set(jid, { mode: 'WAIT_STICKER' });
      await sock.sendMessage(jid, { text: '🖼️ Manda la foto, video o enlace que quieres hacer sticker:' }, { quoted: msg });
    } else if (text === '5') {
      clearAIHistory(jid);
      chatStates.set(jid, { mode: 'AI_CHAT' });
      await sock.sendMessage(jid, { text: '🤖 *Modo IA activado.* Escríbeme lo que quieras (para salir manda *!cancelar*).' }, { quoted: msg });
    }
    return;
  }

  if (state.mode === 'MEDIA_OPTIONS') {
    if (text === '1') {
      const { media: m } = state;
      chatStates.delete(jid);
      await react(sock, jid, msg.key, '⏳');
      const sticker = await convertToSticker(m.buffer, { isAnimated: m.isAnimated, ext: m.ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
    } else if (text === '2' && state.media.isImage) {
      chatStates.set(jid, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [state.media.buffer] });
      await sock.sendMessage(jid, { text: '📄 Página 1 guardada. Manda las demás fotos y al final escribe *!listo* (o *!listo Nombre*).' }, { quoted: msg });
    }
    return;
  }

  if (state.mode === 'LINK_OPTIONS' && /^[123]$/.test(text)) {
    const { url: savedUrl } = state;
    chatStates.delete(jid);
    await executeWAUrl(sock, jid, msg, savedUrl, { '1': 'video', '2': 'audio', '3': 'sticker' }[text]);
    return;
  }

  if (state.mode === 'WAIT_MUSIC' && text) {
    await react(sock, jid, msg.key, '🔍');
    const tracks = await searchTracks(text);
    if (tracks.length === 0) {
      chatStates.delete(jid);
      await sock.sendMessage(jid, { text: '❌ No encontré esa canción.' }, { quoted: msg });
      return;
    }
    chatStates.set(jid, { mode: 'MUSIC_SELECT', tracks });
    const list = tracks.map((t, i) => `${i + 1}️⃣ *${t.title}* - ${t.artist}`).join('\n');
    await sock.sendMessage(jid, { text: `🎵 Elige una opción (*1-${tracks.length}*):\n\n${list}` }, { quoted: msg });
    return;
  }

  if (state.mode === 'MUSIC_SELECT' && /^[1-5]$/.test(text)) {
    const track = state.tracks[Number(text) - 1];
    if (!track) return;
    chatStates.delete(jid);
    await react(sock, jid, msg.key, '⏳');
    try {
      const { buffer, filename } = await downloadTaggedTrack(track);
      await sock.sendMessage(jid, { document: buffer, mimetype: 'audio/mpeg', fileName: filename }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
    } catch (err) {
      await react(sock, jid, msg.key, '❌');
      await sock.sendMessage(jid, { text: `Error: ${err.message}` }, { quoted: msg });
    }
    return;
  }

  if (state.mode === 'PDF_COLLECT' && /^!listo\b/i.test(text)) {
    const customName = text.replace(/^!listo\s*/i, '').trim();
    const filename = customName ? sanitizePdfName(customName) : state.filename;
    const buffers = state.buffers;
    chatStates.delete(jid);
    if (buffers.length === 0) {
      await sock.sendMessage(jid, { text: '⚠️ No mandaste ninguna foto.' }, { quoted: msg });
      return;
    }
    await react(sock, jid, msg.key, '⏳');
    const pdf = await buildPdfFromImages(buffers);
    await sock.sendMessage(jid, { document: pdf, mimetype: 'application/pdf', fileName: filename }, { quoted: msg });
    await react(sock, jid, msg.key, '✅');
  }
}

// ================= TELEGRAM =================
async function tgApi(token, method, body) {
  return (await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
}

async function tgSendFile(token, method, chatId, field, buffer, filename, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(field, new Blob([buffer]), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  return (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form })).json();
}

async function tgDownloadFile(token, fileId) {
  const info = await tgApi(token, 'getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  return Buffer.from(await res.arrayBuffer());
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
          const state = chatStates.get(chatId);

          if (/^(\/cancelar|!cancelar)$/i.test(text)) {
            chatStates.delete(chatId);
            clearAIHistory(chatId);
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: '🛑 Operación cancelada.' });
            continue;
          }

          if (/^(\/start|\/menu|!menu)$/i.test(text)) {
            chatStates.set(chatId, { mode: 'MAIN_MENU' });
            await tgApi(token, 'sendMessage', {
              chat_id: chatId,
              text: '👋 ¿Qué vamos a hacer hoy?',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎬 Video / Audio de enlace', callback_data: 'menu:link' }],
                  [{ text: '🎵 Buscar música con carátula', callback_data: 'menu:music' }],
                  [{ text: '📄 Armar PDF con fotos', callback_data: 'menu:pdf' }],
                  [{ text: '🖼️ Hacer sticker', callback_data: 'menu:sticker' }],
                  [{ text: '🤖 Charlar con IA', callback_data: 'menu:ai' }],
                ],
              },
            });
            continue;
          }

          if (state?.mode === 'AI_CHAT' && text) {
            try {
              const reply = await askAI(chatId, text);
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: reply });
            } catch (err) {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: `❌ Error IA: ${err.message}` });
            }
            continue;
          }

          if (u.message.photo || u.message.video) {
            const isImage = Boolean(u.message.photo);
            const fileId = isImage ? u.message.photo[u.message.photo.length - 1].file_id : u.message.video.file_id;
            const buffer = await tgDownloadFile(token, fileId);

            if (state?.mode === 'PDF_COLLECT' && isImage) {
              state.buffers.push(buffer);
              continue;
            }
            if (state?.mode === 'WAIT_STICKER') {
              chatStates.delete(chatId);
              const sticker = await convertToSticker(buffer, { isAnimated: !isImage, ext: isImage ? 'jpg' : 'mp4', packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
              await tgSendFile(token, 'sendSticker', chatId, 'sticker', sticker, 'sticker.webp');
              continue;
            }

            chatStates.set(chatId, { mode: 'MEDIA_OPTIONS', media: { buffer, isAnimated: !isImage, ext: isImage ? 'jpg' : 'mp4', isImage } });
            const kb = isImage
              ? [[{ text: '🖼️ Hacer Sticker', callback_data: 'media:sticker' }, { text: '📄 Iniciar PDF', callback_data: 'media:pdf' }]]
              : [[{ text: '🖼️ Hacer Sticker Animado', callback_data: 'media:sticker' }]];
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: '¿Qué hacemos con esto?', reply_to_message_id: u.message.message_id, reply_markup: { inline_keyboard: kb } });
            continue;
          }

          const url = extractUrl(text);
          if (url) {
            chatStates.set(chatId, { mode: 'LINK_OPTIONS', url });
            await tgApi(token, 'sendMessage', {
              chat_id: chatId,
              text: '¿Qué hacemos con este enlace?',
              reply_to_message_id: u.message.message_id,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎬 Video', callback_data: 'url:video' }, { text: '🎵 Audio', callback_data: 'url:audio' }],
                  [{ text: '🖼️ Sticker', callback_data: 'url:sticker' }],
                ],
              },
            });
            continue;
          }

          if (state?.mode === 'WAIT_MUSIC' && text) {
            const tracks = await searchTracks(text);
            if (tracks.length === 0) {
              chatStates.delete(chatId);
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: '❌ No encontré esa canción.' });
              continue;
            }
            chatStates.set(chatId, { mode: 'MUSIC_SELECT', tracks });
            const buttons = tracks.map((t, i) => [{ text: `🎵 ${t.title} - ${t.artist}`, callback_data: `song:${i}` }]);
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'Elige la canción:', reply_markup: { inline_keyboard: buttons } });
            continue;
          }

          if (state?.mode === 'PDF_COLLECT' && /^(\/listo|!listo)\b/i.test(text)) {
            const customName = text.replace(/^(\/listo|!listo)\s*/i, '').trim();
            const filename = customName ? sanitizePdfName(customName) : state.filename;
            const buffers = state.buffers;
            chatStates.delete(chatId);
            if (buffers.length === 0) {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⚠️ No mandaste fotos.' });
              continue;
            }
            const wait = await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⏳ Armando PDF...' });
            const pdf = await buildPdfFromImages(buffers);
            await tgSendFile(token, 'sendDocument', chatId, 'document', pdf, filename);
            await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: wait.result.message_id });
          }
        }

        if (u.callback_query) {
          const cb = u.callback_query;
          const chatId = String(cb.message.chat.id);
          const msgId = cb.message.message_id;
          const state = chatStates.get(chatId);
          const [type, val] = (cb.data || '').split(':');
          await tgApi(token, 'answerCallbackQuery', { callback_query_id: cb.id });

          if (type === 'menu') {
            if (val === 'link') {
              chatStates.set(chatId, { mode: 'WAIT_LINK' });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '🔗 Pega el enlace de X, TikTok, IG o YouTube:' });
            } else if (val === 'music') {
              chatStates.set(chatId, { mode: 'WAIT_MUSIC' });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '🎵 Escribe el nombre de la canción:' });
            } else if (val === 'pdf') {
              chatStates.set(chatId, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [] });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '📄 Manda tus fotos y al final escribe /listo' });
            } else if (val === 'sticker') {
              chatStates.set(chatId, { mode: 'WAIT_STICKER' });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '🖼️ Manda la foto, video o enlace:' });
            } else if (val === 'ai') {
              clearAIHistory(chatId);
              chatStates.set(chatId, { mode: 'AI_CHAT' });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '🤖 Modo IA activado. Escríbeme lo que quieras (para salir manda /cancelar).' });
            }
          } else if (type === 'media' && state?.media) {
            const m = state.media;
            if (val === 'sticker') {
              chatStates.delete(chatId);
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '⏳ Haciendo sticker...' });
              const sticker = await convertToSticker(m.buffer, { isAnimated: m.isAnimated, ext: m.ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
              await tgSendFile(token, 'sendSticker', chatId, 'sticker', sticker, 'sticker.webp');
              await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
            } else if (val === 'pdf' && m.isImage) {
              chatStates.set(chatId, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [m.buffer] });
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: '📄 Página 1 guardada. Manda más fotos y al final escribe /listo' });
            }
          } else if (type === 'url' && state?.url) {
            const url = state.url;
            chatStates.delete(chatId);
            await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: `⏳ Procesando ${val}...` });
            try {
              if (val === 'video') {
                const { buffer } = await downloadFromUrl(url, 'video');
                await tgSendFile(token, 'sendVideo', chatId, 'video', buffer, 'video.mp4');
              } else if (val === 'audio') {
                const { buffer } = await downloadFromUrl(url, 'audio');
                await tgSendFile(token, 'sendAudio', chatId, 'audio', buffer, 'audio.mp3');
              } else {
                const { buffer, ext } = await downloadFromUrl(url, 'sticker');
                const sticker = await convertToSticker(buffer, { isAnimated: true, ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
                await tgSendFile(token, 'sendSticker', chatId, 'sticker', sticker, 'sticker.webp');
              }
              await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
            } catch (err) {
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: `❌ Error: ${err.message}` });
            }
          } else if (type === 'song' && state?.tracks) {
            const track = state.tracks[Number(val)];
            chatStates.delete(chatId);
            if (!track) return;
            await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: `⏳ Descargando "${track.title}"...` });
            try {
              const { buffer, filename } = await downloadTaggedTrack(track);
              await tgSendFile(token, 'sendAudio', chatId, 'audio', buffer, filename, { title: track.title, performer: track.artist });
              await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
            } catch (err) {
              await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text: `❌ Error: ${err.message}` });
            }
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
