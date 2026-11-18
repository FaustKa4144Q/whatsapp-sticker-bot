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
  return `Eres un asistente personal integrado en WhatsApp y Telegram con herramientas reales para descargar música en MP3, videos, hacer stickers, armar PDFs y poner recordatorios. NUNCA digas que no puedes descargar canciones ni des sermones de derechos de autor; usa tus acciones integradas.
Fecha y hora actual en México (UTC-6): ${getMexicoTimeContext()}

Responde SIEMPRE usando exactamente estas 3 líneas (una debajo de otra, sin usar "|"):
ACCION: chat
QUERY: 
RESPUESTA: tu mensaje corto y natural en español

Valores permitidos para ACCION:
- music: cuando pida buscar, escuchar o descargar una canción en MP3 (incluso si dice "dámela en mp3" refiriéndose a una canción que acaban de mencionar). En QUERY pon "Nombre de la canción Artista" (ej. Yo Perreo Sola Bad Bunny). Si no dijo qué canción quiere aún, usa ACCION: chat y pregúntale cuál busca.
- reminder: cuando pida que le recuerdes algo o poner alarma. En QUERY pon: FECHA_ISO_MEXICO|TEXTO_DEL_RECORDATORIO (ej. 2026-11-18T19:00:00-06:00|Subir tarea). Usa siempre -06:00.
- list_reminders: si pregunta qué recordatorios tiene pendientes.
- clear_reminders: si pide borrar sus recordatorios.
- menu: si pide ver el menú, ayuda o qué sabes hacer.
- pdf: si quiere hacer/armar un PDF o escanear tarea (pon en QUERY el nombre del archivo si lo dijo, o déjalo vacío).
- sticker: si manda un link y pide hacerlo sticker (pon el link en QUERY).
- download_video: si manda un link y pide descargar video (pon el link en QUERY).
- download_audio: si manda un link y pide descargar audio (pon el link en QUERY).
- chat: para saludos, preguntas o plática normal.`;
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
  const valid = allIds.filter(
    (id) =>
      /^(llama|meta-llama|openai\/gpt-oss|gemma|mixtral)/i.test(id) &&
      !/whisper|guard|tts|embed|vision|orpheus|safeguard/i.test(id),
  );

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
    throw new Error('No hay modelos de chat disponibles en tu cuenta de Groq.');
  }

  cachedModels = valid;
  return cachedModels;
}

function parseAIResponse(rawText) {
  const actionMatch = rawText.match(/ACCION:\s*([a-z_]+)/i);
  const queryMatch = rawText.match(/QUERY:\s*([\s\S]*?)(?=\s*(?:\|\s*)?RESPUESTA:|$)/i);
  const replyMatch = rawText.match(/RESPUESTA:\s*([\s\S]*)$/i);

  const rawAction = (actionMatch?.[1] || 'chat').toLowerCase().trim();
  const action = VALID_ACTIONS.has(rawAction) ? rawAction : 'chat';
  const query = (queryMatch?.[1] || '').replace(/\|\s*$/, '').trim();
  const reply = (replyMatch?.[1] || rawText)
    .replace(/ACCION:[\s\S]*?RESPUESTA:\s*/i, '')
    .trim();

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
        temperature: 0.5,
      }),
    });

    const json = await res.json();
    if (res.ok) {
      data = json;
      break;
    }

    lastError = json.error?.message || `Groq HTTP ${res.status}`;
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
