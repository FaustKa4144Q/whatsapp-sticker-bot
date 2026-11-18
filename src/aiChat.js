const histories = new Map();
let cachedModels = [];

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

async function getValidChatModels(apiKey) {
  if (cachedModels.length > 0) return cachedModels;

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Error listando modelos (${res.status})`);
  }

  const allIds = (data.data || []).map((m) => m.id);

  // Solo modelos reales de chat, descartando voz (orpheus/whisper), guard, vision, etc.
  const valid = allIds.filter(
    (id) =>
      /^(llama|meta-llama|openai\/gpt-oss|gemma|mixtral)/i.test(id) &&
      !/whisper|guard|tts|embed|vision|orpheus|safeguard/i.test(id),
  );

  // Ordenar poniendo primero los más rápidos y estables
  valid.sort((a, b) => {
    const score = (id) => {
      if (/llama-3\.1-8b-instant/i.test(id)) return 1;
      if (/llama-3\.3-70b/i.test(id)) return 2;
      if (/gpt-oss-20b/i.test(id)) return 3;
      if (/llama/i.test(id)) return 4;
      return 5;
    };
    return score(a) - score(b);
  });

  if (valid.length === 0) {
    throw new Error(`No encontré modelos de chat compatibles. Disponibles: ${allIds.join(', ')}`);
  }

  cachedModels = valid;
  return cachedModels;
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

  const models = await getValidChatModels(apiKey);
  const history = histories.get(chatId) || [];
  history.push({ role: 'user', content: userText });

  if (history.length > 8) {
    history.splice(0, history.length - 8);
  }

  let data = null;
  let lastError = null;

  for (const model of models) {
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

    const json = await res.json();
    if (res.ok) {
      data = json;
      break;
    }

    lastError = json.error?.message || `Groq HTTP ${res.status}`;
    // Si el modelo pide términos, no existe o se pasó de límite, lo quitamos y probamos el siguiente
    if (/terms|not exist|access|limit|decommissioned|not supported/i.test(lastError)) {
      cachedModels = cachedModels.filter((m) => m !== model);
      continue;
    }
    throw new Error(lastError);
  }

  if (!data) {
    cachedModels = [];
    throw new Error(lastError || 'Ningún modelo de Groq respondió.');
  }

  const rawText = data.choices?.[0]?.message?.content || '';
  const parsed = parseAIResponse(rawText);

  history.push({ role: 'assistant', content: parsed.reply });
  histories.set(chatId, history);

  return parsed;
}
