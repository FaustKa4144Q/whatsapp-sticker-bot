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
import { clearAIHistory, processWithAI } from './aiChat.js';
import { config } from './config.js';
import { downloadTaggedTrack, searchTracks } from './musicFinder.js';
import { buildPdfFromImages } from './pdfBuilder.js';
import { convertToSticker } from './stickerConverter.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();
const chatStates = new Map();
const botSentIds = new Set();

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

const MENU_TEXT =
  'Esto es lo que puedo hacer por ti (solo pídemelo normal):\n\n' +
  '🎬 *Videos y audios:* Pásame un link de X, TikTok, IG o YouTube y dime si quieres el video, el audio o un sticker.\n' +
  '🎵 *Música con carátula:* Dime *"búscame [canción]"* y te la bajo en MP3 etiquetado.\n' +
  '📄 *Tareas en PDF:* Dime *"quiero hacer un pdf"*, manda tus fotos y al final dime *listo*.\n' +
  '🖼️ *Stickers:* Mándame cualquier foto o video corto.\n' +
  '💬 *Plática libre:* Pregúntame o platícame lo que quieras.';

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
  if (botSentIds.has(msg.key.id)) return;

  const c = unwrapMessage(msg.message);
  if (!c) return;

  const text = extractText(c);
  if (text === '!id' && jid.endsWith('@g.us')) {
    await sock.sendMessage(jid, { text: `JID:\n${jid}` }, { quoted: msg });
    return;
  }

  const isGroup = jid.endsWith('@g.us');
  const myNum = sock.user?.id?.split(':')[0];
  const isSelfChat =
    (!isGroup && msg.key.fromMe) ||
    (myNum && jid.startsWith(myNum)) ||
    config.allowedUserJids.includes(jid);
  const isAllowedGroup =
    isGroup &&
    (config.allowedGroupJids.includes(jid) ||
      config.allowedGroupNames.includes(await getGroupSubject(sock, jid)));

  if (!isSelfChat && !isAllowedGroup) return;

  const state = chatStates.get(jid);

  if (isGroup && state?.mode !== 'PDF_COLLECT' && !/^(ey|bot|!)\b/i.test(text) && !detectMedia(c)) {
    return;
  }

  if (/^(!?cancelar|ya estuvo)$/i.test(text)) {
    chatStates.delete(jid);
    clearAIHistory(jid);
    await sock.sendMessage(jid, { text: '🛑 Listo, cancelado.' }, { quoted: msg });
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
    if (media.isImage && /pdf/i.test(text)) {
      chatStates.set(jid, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [buffer] });
      await sock.sendMessage(jid, { text: '📄 Página 1 guardada. Manda las demás fotos y cuando acabes dime *listo*.' }, { quoted: msg });
      return;
    }
    await react(sock, jid, msg.key, '⏳');
    try {
      const sticker = await convertToSticker(buffer, { isAnimated: media.isAnimated, ext: media.ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
      await sock.sendMessage(jid, { sticker }, { quoted: msg });
      await react(sock, jid, msg.key, '✅');
    } catch (err) {
      await react(sock, jid, msg.key, '❌');
      await sock.sendMessage(jid, { text: `Error: ${err.message}` }, { quoted: msg });
    }
    return;
  }

  if (state?.mode === 'PDF_COLLECT' && /^(!?listo|terminé|termine|ya|armalo|ármalo)\b/i.test(text)) {
    const customName = text.replace(/^(!?listo|terminé|termine|ya|armalo|ármalo)\s*/i, '').trim();
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
    return;
  }

  if (state?.mode === 'MUSIC_SELECT' && /^[1-5]$/.test(text)) {
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

  if (state?.mode === 'LINK_OPTIONS' && /^[123]$/.test(text)) {
    const { url } = state;
    chatStates.delete(jid);
    return await executeWAUrl(sock, jid, msg, url, { '1': 'video', '2': 'audio', '3': 'sticker' }[text]);
  }

  if (!text) return;

  const soloUrl = extractUrl(text);
  if (soloUrl && text.replace(soloUrl, '').trim() === '') {
    chatStates.set(jid, { mode: 'LINK_OPTIONS', url: soloUrl });
    await sock.sendMessage(jid, { text: '¿Cómo lo quieres?\n1️⃣ Video\n2️⃣ Audio\n3️⃣ Sticker' }, { quoted: msg });
    return;
  }

  try {
    const ai = await processWithAI(jid, text);
    if (ai.action === 'menu') {
      await sock.sendMessage(jid, { text: MENU_TEXT }, { quoted: msg });
    } else if (ai.action === 'pdf') {
      const filename = ai.query ? sanitizePdfName(ai.query) : 'Tarea.pdf';
      chatStates.set(jid, { mode: 'PDF_COLLECT', filename, buffers: [] });
      await sock.sendMessage(jid, { text: `📄 Va, manda las fotos para *${filename}* y cuando termines dime *listo*.` }, { quoted: msg });
    } else if (ai.action === 'music' && ai.query) {
      await react(sock, jid, msg.key, '🔍');
      const tracks = await searchTracks(ai.query);
      if (tracks.length === 0) {
        await sock.sendMessage(jid, { text: `❌ No encontré "${ai.query}".` }, { quoted: msg });
        return;
      }
      chatStates.set(jid, { mode: 'MUSIC_SELECT', tracks });
      const list = tracks.map((t, i) => `${i + 1}️⃣ *${t.title}* - ${t.artist}`).join('\n');
      await sock.sendMessage(jid, { text: `🎵 Encontré estas (responde del *1* al *${tracks.length}*):\n\n${list}` }, { quoted: msg });
    } else if (ai.action === 'download_video' && (ai.query || soloUrl)) {
      await executeWAUrl(sock, jid, msg, ai.query || soloUrl, 'video');
    } else if (ai.action === 'download_audio' && (ai.query || soloUrl)) {
      await executeWAUrl(sock, jid, msg, ai.query || soloUrl, 'audio');
    } else if (ai.action === 'sticker' && (ai.query || soloUrl)) {
      await executeWAUrl(sock, jid, msg, ai.query || soloUrl, 'sticker');
    } else {
      await sock.sendMessage(jid, { text: ai.reply }, { quoted: msg });
    }
  } catch (err) {
    await sock.sendMessage(jid, { text: `❌ Error IA: ${err.message}` }, { quoted: msg });
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
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: '🛑 Cancelado.' });
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
            const sticker = await convertToSticker(buffer, { isAnimated: !isImage, ext: isImage ? 'jpg' : 'mp4', packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
            await tgSendFile(token, 'sendSticker', chatId, 'sticker', sticker, 'sticker.webp');
            continue;
          }

          if (state?.mode === 'PDF_COLLECT' && /^(\/?listo|terminé|termine|ya|armalo|ármalo)\b/i.test(text)) {
            const customName = text.replace(/^(\/?listo|terminé|termine|ya|armalo|ármalo)\s*/i, '').trim();
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
            continue;
          }

          if (!text) continue;

          const soloUrl = extractUrl(text);
          if (soloUrl && text.replace(soloUrl, '').trim() === '') {
            chatStates.set(chatId, { mode: 'LINK_OPTIONS', url: soloUrl });
            await tgApi(token, 'sendMessage', {
              chat_id: chatId,
              text: '¿Cómo lo quieres?',
              reply_markup: { inline_keyboard: [[{ text: '🎬 Video', callback_data: 'url:video' }, { text: '🎵 Audio', callback_data: 'url:audio' }], [{ text: '🖼️ Sticker', callback_data: 'url:sticker' }]] },
            });
            continue;
          }

          try {
            const ai = await processWithAI(chatId, text);
            if (ai.action === 'menu') {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: MENU_TEXT });
            } else if (ai.action === 'pdf') {
              const filename = ai.query ? sanitizePdfName(ai.query) : 'Tarea.pdf';
              chatStates.set(chatId, { mode: 'PDF_COLLECT', filename, buffers: [] });
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: `📄 Va, manda las fotos para ${filename} y cuando termines dime listo.` });
            } else if (ai.action === 'music' && ai.query) {
              const tracks = await searchTracks(ai.query);
              if (tracks.length === 0) {
                await tgApi(token, 'sendMessage', { chat_id: chatId, text: `❌ No encontré "${ai.query}".` });
                continue;
              }
              chatStates.set(chatId, { mode: 'MUSIC_SELECT', tracks });
              const buttons = tracks.map((t, i) => [{ text: `🎵 ${t.title} - ${t.artist}`, callback_data: `song:${i}` }]);
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'Elige la canción:', reply_markup: { inline_keyboard: buttons } });
            } else if (['download_video', 'download_audio', 'sticker'].includes(ai.action) && (ai.query || soloUrl)) {
              const target = ai.query || soloUrl;
              const wait = await tgApi(token, 'sendMessage', { chat_id: chatId, text: '⏳ Procesando...' });
              try {
                if (ai.action === 'download_video') {
                  const { buffer } = await downloadFromUrl(target, 'video');
                  await tgSendFile(token, 'sendVideo', chatId, 'video', buffer, 'video.mp4');
                } else if (ai.action === 'download_audio') {
                  const { buffer } = await downloadFromUrl(target, 'audio');
                  await tgSendFile(token, 'sendAudio', chatId, 'audio', buffer, 'audio.mp3');
                } else {
                  const { buffer, ext } = await downloadFromUrl(target, 'sticker');
                  const sticker = await convertToSticker(buffer, { isAnimated: true, ext, packName: config.packName, author: config.author, maxVideoSeconds: config.maxVideoSeconds });
                  await tgSendFile(token, 'sendSticker', chatId, 'sticker', sticker, 'sticker.webp');
                }
                await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: wait.result.message_id });
              } catch (err) {
                await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: wait.result.message_id, text: `❌ Error: ${err.message}` });
              }
            } else {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: ai.reply });
            }
          } catch (err) {
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: `❌ Error IA: ${err.message}` });
          }
        }

        if (u.callback_query) {
          const cb = u.callback_query;
          const chatId = String(cb.message.chat.id);
          const msgId = cb.message.message_id;
          const state = chatStates.get(chatId);
          const [type, val] = (cb.data || '').split(':');
          await tgApi(token, 'answerCallbackQuery', { callback_query_id: cb.id });

          if (type === 'url' && state?.url) {
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

  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const sent = await origSend(...args);
    if (sent?.key?.id) {
      botSentIds.add(sent.key.id);
      setTimeout(() => botSentIds.delete(sent.key.id), 60000);
    }
    return sent;
  };

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
