const histories = new Map();
let cachedModel = null;

export function clearAIHistory(chatId) {
  histories.delete(chatId);
}

function getMexicoTimeContext() {
  const now = new Date();
  const readable = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(now);

  const mxParts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);

  return `${readable} (ISO actual México: ${mxParts.replace(' ', 'T')}-06:00)`;
}

function buildSystemPrompt() {
  return `Eres un asistente personal integrado en WhatsApp y Telegram. Hablas en español de forma natural, directa y relajada (ideal para leer rápido en el celular).
Fecha y hora actual en México (UTC-6): ${getMexicoTimeContext()}

Analiza el mensaje del usuario y responde SIEMPRE empezando con estas 3 etiquetas exactas:
ACCION: chat | menu | music | pdf | sticker | download_video | download_audio | reminder | list_reminders | clear_reminders
QUERY: texto extraído según la acción (o déjalo vacío si no aplica)
RESPUESTA: tu respuesta natural para el usuario

Reglas para elegir ACCION:
- reminder: si pide que le recuerdes algo, poner una alarma o avisarle a una hora/fecha (ej. "recuérdame en 15 min...", "avísame hoy a las 7pm...", "recuérdame el domingo a las 8am..."). En QUERY pon EXACTAMENTE: FECHA_ISO_MEXICO|TEXTO_DEL_RECORDATORIO (ejemplo: 2026-11-18T19:00:00-06:00|Subir la tarea). Usa siempre zona horaria -06:00.
- list_reminders: si pregunta qué recordatorios o alarmas tiene pendientes.
- clear_reminders: si pide borrar o cancelar sus recordatorios pendientes.
- menu: si pide ver el menú, ayuda, opciones o qué sabes hacer.
- music: si pide buscar, escuchar o descargar una canción (pon en QUERY el nombre de la canción y artista).
- pdf: si dice que quiere hacer/armar un PDF o escanear una tarea (pon en QUERY el nombre del archivo si lo mencionó, o déjalo vacío).
- sticker: si manda un enlace y pide hacerlo sticker (pon el link en QUERY).
- download_video: si manda un enlace y pide descargar el video (pon el link en QUERY).
- download_audio: si manda un enlace y pide solo el audio/mp3 (pon el link en QUERY).
- chat: para cualquier charla, ejemplo, explicación o pregunta normal.`;
}

const VALID_ACTIONS = new Set([
  'chat',
  'menu',
  'music',
  'pdf',
  'sticker',
  'download_video',
  'download_audio',
  'reminder',
  'list_reminders',
  'clear_reminders',
]);

async function getBestGroqModel(apiKey) {
  if (cachedModel) return cachedModel;

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Error listando modelos (${res.status})`);
  }

  const chatModels = (data.data || [])
    .map((m) => m.id)
    .filter((id) => !/whisper|guard|tts|embed|vision/i.test(id));

  cachedModel =
    chatModels.find((id) => /llama-3\.1-8b-instant/i.test(id)) ||
    chatModels.find((id) => /llama.*8b|llama.*70b/i.test(id)) ||
    chatModels.find((id) => /llama|gemma|mixtral/i.test(id)) ||
    chatModels[0];

  if (!cachedModel) {
    throw new Error('No hay modelos de chat disponibles en tu cuenta de Groq.');
  }
  return cachedModel;
}

function parseAIResponse(rawText) {
  const actionMatch = rawText.match(/^ACCION:\s*([a-z_]+)/im);
  const queryMatch = rawText.match(/^QUERY:\s*(.*)$/im);
  const hasReplyTag = /^RESPUESTA:\s*/im.test(rawText);

  const rawAction = (actionMatch?.[1] || 'chat').toLowerCase().trim();
  const action = VALID_ACTIONS.has(rawAction) ? rawAction : 'chat';
  const query = (queryMatch?.[1] || '').trim();
  const reply = hasReplyTag
    ? rawText.replace(/^[\s\S]*?^RESPUESTA:\s*/im, '').trim()
    : rawText.trim();

  return {
    action,
    query,
    reply: reply || 'Listo.',
  };
}

export async function processWithAI(chatId, userText) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('No detecto GROQ_API_KEY en Railway.');
  }

  const model = await getBestGroqModel(apiKey);
  const history = histories.get(chatId) || [];
  history.push({ role: 'user', content: userText });

  if (history.length > 8) {
    history.splice(0, history.length - 8);
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    cachedModel = null;
    throw new Error(data.error?.message || `Groq HTTP ${res.status}`);
  }

  const rawText = data.choices?.[0]?.message?.content || '';
  const parsed = parseAIResponse(rawText);

  history.push({ role: 'assistant', content: parsed.reply });
  histories.set(chatId, history);

  return parsed;
}
