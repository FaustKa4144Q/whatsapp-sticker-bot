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
  'Esto es lo que puedo hacer por ti (solo pídemelo normal):\n\n' +
  '⏰ *Recordatorios:* Dime *"recuérdame hoy a las 7pm..."* o *"en 20 min..."* y te aviso aquí mismo.\n' +
  '🎬 *Videos y audios:* Pásame un link de X, TikTok, IG o YouTube y dime si quieres video, audio o sticker.\n' +
  '🎵 *Música con carátula:* Dime *"búscame [canción]"* y te la bajo en MP3 etiquetado.\n' +
  '📄 *Tareas en PDF:* Dime *"quiero hacer un pdf"*, manda tus fotos y al final dime *listo*.\n' +
  '🖼️ *Stickers:* Mándame cualquier foto o video corto.\n' +
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

function handleReminderAction(platform, stateKey, ai) {
  if (ai.action === 'reminder') {
    const [isoTime, ...rest] = (ai.query || '').split('|');
    const reminderText = rest.join('|').trim();
    const item = addReminder({ platform, chatId: stateKey, text: reminderText, isoTime: isoTime.trim() });
    return `⏰ Listo, te aviso el *${formatMexicoDate(item.triggerAt)}*:\n"${item.text}"`;
  }
  if (ai.action === 'list_reminders') {
    const list = getUserReminders(platform, stateKey);
    if (list.length === 0) return '📭 No tienes recordatorios pendientes.';
    const lines = list.map((r, i) => `${i + 1}. *${formatMexicoDate(r.triggerAt)}* — ${r.text}`);
    return `⏰ *Tus recordatorios pendientes:*\n\n${lines.join('\n')}`;
  }
  if (ai.action === 'clear_reminders') {
    const count = clearUserReminders(platform, stateKey);
    return count > 0 ? `🗑️ Listo, borré ${count} recordatorio(s).` : '📭 No tenías recordatorios activos.';
  }
  return null;
}

async function handleWAMessage(slotNum, sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (botSentIds.has(msg.key.id)) return;

  const c = unwrapMessage(msg.message);
  if (!c) return;

  const text = extractText(c);
  const isGroup = jid.endsWith('@g.us');

  if (text === '!id' && isGroup) {
    await sock.sendMessage(jid, { text: `JID:\n${jid}` }, { quoted: msg });
    return;
  }

  if (text.toLowerCase() === '!yo' && !isGroup && msg.key.fromMe) {
    saveSelfJid(jid);
    await sock.sendMessage(jid, { text: '✅ Chat personal vinculado correctamente.' }, { quoted: msg });
    return;
  }

  const myNum = sock.user?.id?.split(':')[0]?.split('@')[0] || '';
  const myLid = sock.user?.lid?.split(':')[0]?.split('@')[0] || '';
  const jidUser = jid.split('@')[0];
  const last10 = myNum.slice(-10);

  const isSelfChat =
    !isGroup &&
    ((last10.length === 10 && jidUser.endsWith(last10)) ||
      (myLid && jidUser === myLid) ||
      savedSelfJids.has(jid) ||
      config.allowedUserJids.includes(jid));

  const isAllowedGroup =
    isGroup &&
    (config.allowedGroupJids.includes(jid) ||
      config.allowedGroupNames.includes(await getGroupSubject(sock, jid)));

  if (!isSelfChat && !isAllowedGroup) return;

  const stateKey = `${slotNum}:${jid}`;
  const state = chatStates.get(stateKey);
  const media = detectMedia(c);
  const ctx = getContextInfo(c);

  const repliedToBot = Boolean(ctx?.stanzaId && botSentIds.has(ctx.stanzaId));
  const mentionedBot = Boolean(
    (myNum && (ctx?.mentionedJid || []).some((m) => m.startsWith(myNum))) ||
      (myLid && (ctx?.mentionedJid || []).some((m) => m.startsWith(myLid))),
  );
  const hasPrefix = /^(ey|bot|!)\b/i.test(text);
  const isPendingChoice =
    (state?.mode === 'MUSIC_SELECT' && /^!?[1-5]$/.test(text)) ||
    (state?.mode === 'LINK_OPTIONS' && /^!?[1-3]$/.test(text));

  if (
    isGroup &&
    !media &&
    state?.mode !== 'PDF_COLLECT' &&
    !isPendingChoice &&
    !repliedToBot &&
    !mentionedBot &&
    !hasPrefix
  ) {
    return;
  }

  if (/^(!?cancelar|ya estuvo)$/i.test(text)) {
    chatStates.delete(stateKey);
    clearAIHistory(stateKey);
    await sock.sendMessage(jid, { text: '🛑 Listo, cancelado.' }, { quoted: msg });
    return;
  }

  if (media) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
    if (state?.mode === 'PDF_COLLECT' && media.isImage) {
      state.buffers.push(buffer);
      await react(sock, jid, msg.key, '📄');
      return;
    }
    if (media.isImage && /pdf/i.test(text)) {
      chatStates.set(stateKey, { mode: 'PDF_COLLECT', filename: 'Tarea.pdf', buffers: [buffer] });
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
    chatStates.delete(stateKey);
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

  if (state?.mode === 'MUSIC_SELECT' && /^!?[1-5]$/.test(text)) {
    const num = Number(text.replace('!', ''));
    const track = state.tracks[num - 1];
    if (!track) return;
    chatStates.delete(stateKey);
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

  if (state?.mode === 'LINK_OPTIONS' && /^!?[123]$/.test(text)) {
    const num = text.replace('!', '');
    const { url } = state;
    chatStates.delete(stateKey);
    return await executeWAUrl(sock, jid, msg, url, { '1': 'video', '2': 'audio', '3': 'sticker' }[num]);
  }

  if (!text) return;

  const soloUrl = extractUrl(text);
  if (soloUrl && text.replace(soloUrl, '').trim() === '') {
    chatStates.set(stateKey, { mode: 'LINK_OPTIONS', url: soloUrl });
    await sock.sendMessage(jid, { text: '¿Cómo lo quieres?\n1️⃣ Video\n2️⃣ Audio\n3️⃣ Sticker' }, { quoted: msg });
    return;
  }

  const cleanPrompt = text.replace(/^@\d+\s*/g, '').replace(/^(ey|bot|!)\s*/i, '').trim() || text;

  try {
    const ai = await processWithAI(stateKey, cleanPrompt);
    const remReply = handleReminderAction('wa', stateKey, ai);
    if (remReply) {
      await sock.sendMessage(jid, { text: remReply }, { quoted: msg });
    } else if (ai.action === 'menu') {
      await sock.sendMessage(jid, { text: MENU_TEXT }, { quoted: msg });
    } else if (ai.action === 'pdf') {
      const filename = ai.query ? sanitizePdfName(ai.query) : 'Tarea.pdf';
      chatStates.set(stateKey, { mode: 'PDF_COLLECT', filename, buffers: [] });
      await sock.sendMessage(jid, { text: `📄 Va, manda las fotos para *${filename}* y cuando termines dime *listo*.` }, { quoted: msg });
    } else if (ai.action === 'music' && ai.query) {
      await react(sock, jid, msg.key, '🔍');
      const tracks = await searchTracks(ai.query);
      if (tracks.length === 0) {
        await sock.sendMessage(jid, { text: `❌ No encontré "${ai.query}".` }, { quoted: msg });
        return;
      }
      chatStates.set(stateKey, { mode: 'MUSIC_SELECT', tracks });
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
    await sock.sendMessage(jid, { text: `❌ Error: ${err.message}` }, { quoted: msg });
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
            const remReply = handleReminderAction('tg', chatId, ai);
            if (remReply) {
              await tgApi(token, 'sendMessage', { chat_id: chatId, text: remReply });
            } else if (ai.action === 'menu') {
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
            await tgApi(token, 'sendMessage', { chat_id: chatId, text: `❌ Error: ${err.message}` });
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

async function startWASlot(slotNum) {
  const slot = sessions[slotNum];
  const { state, saveCreds } = await useMultiFileAuthState(path.join('auth_info', slot.folder));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', `20.0.${slotNum}`],
  });
  slot.sock = sock;

  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const sent = await origSend(...args);
    if (sent?.key?.id) {
      botSentIds.add(sent.key.id);
      setTimeout(() => botSentIds.delete(sent.key.id), 300000);
    }
    return sent;
  };

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { slot.qr = qr; slot.status = 'Esperando QR'; }
    if (connection === 'close') {
      slot.status = 'Reconectando...';
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startWASlot(slotNum), 3000);
      } else {
        slot.status = 'Sesión cerrada';
      }
    } else if (connection === 'open') {
      slot.qr = null;
      slot.status = 'Conectado';
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const msg of messages) {
      const msgTs = Number(msg.messageTimestamp || nowSec);
      if (nowSec - msgTs > 30) continue;
      await handleWAMessage(slotNum, sock, msg);
    }
  });
}

export async function startBot() {
  if (!backgroundLoopsStarted) {
    backgroundLoopsStarted = true;
    startTelegramBot();
    startReminderLoop({
      sendWA: async (stateKey, text) => {
        const idx = stateKey.indexOf(':');
        const slotNum = Number(stateKey.slice(0, idx));
        const jid = stateKey.slice(idx + 1);
        const sock = sessions[slotNum]?.sock;
        if (sock) await sock.sendMessage(jid, { text });
      },
      sendTG: async (chatId, text) => {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (token) await tgApi(token, 'sendMessage', { chat_id: chatId, text });
      },
    });
  }

  startWASlot(1);
  startWASlot(2);
}
