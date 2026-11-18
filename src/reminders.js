import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'auth_info';
const FILE_PATH = path.join(DATA_DIR, 'reminders.json');

function loadReminders() {
  try {
    if (!fs.existsSync(FILE_PATH)) return [];
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReminders(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2));
}

export function formatMexicoDate(ts) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ts));
}

export function addReminder({ platform, chatId, text, isoTime }) {
  const triggerAt = Date.parse(isoTime);
  if (Number.isNaN(triggerAt)) {
    throw new Error('No entendí bien la fecha u hora del recordatorio.');
  }
  if (triggerAt <= Date.now() - 30000) {
    throw new Error('Esa hora ya pasó. Dime una hora futura.');
  }

  const list = loadReminders();
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    platform,
    chatId: String(chatId),
    text: text.trim() || 'Recordatorio',
    triggerAt,
  };
  list.push(item);
  saveReminders(list);
  return item;
}

export function getUserReminders(platform, chatId) {
  return loadReminders()
    .filter((r) => r.platform === platform && r.chatId === String(chatId))
    .sort((a, b) => a.triggerAt - b.triggerAt);
}

export function clearUserReminders(platform, chatId) {
  const list = loadReminders();
  const filtered = list.filter(
    (r) => !(r.platform === platform && r.chatId === String(chatId)),
  );
  saveReminders(filtered);
  return list.length - filtered.length;
}

export function startReminderLoop({ sendWA, sendTG }) {
  setInterval(async () => {
    const list = loadReminders();
    if (list.length === 0) return;

    const now = Date.now();
    const due = list.filter((r) => r.triggerAt <= now);
    if (due.length === 0) return;

    const remaining = list.filter((r) => r.triggerAt > now);
    saveReminders(remaining);

    for (const r of due) {
      const msg = `⏰ *Recordatorio:*\n${r.text}`;
      try {
        if (r.platform === 'wa') await sendWA(r.chatId, msg);
        else if (r.platform === 'tg') await sendTG(r.chatId, msg);
      } catch (err) {
        console.error('Error enviando recordatorio:', err.message);
      }
    }
  }, 10000);
}
