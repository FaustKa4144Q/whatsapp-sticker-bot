const histories = new Map();
let cachedModel = null;

export function clearAIHistory(chatId) {
  histories.delete(chatId);
}

const SYSTEM_PROMPT = `Eres un asistente personal integrado en WhatsApp y Telegram. Hablas en español de forma natural, directa y relajada (ideal para leer rápido en el celular).

Analiza el mensaje del usuario y responde SIEMPRE empezando con estas 3 etiquetas exactas:
ACCION: chat | menu | music | pdf | sticker | download_video | download_audio
QUERY: texto extraído según la acción (o déjalo vacío si no aplica)
RESPUESTA: tu respuesta natural para el usuario (aquí puedes escribir varios párrafos, ejemplos o fórmulas matemáticas sin problema)

Reglas para elegir ACCION:
- menu: si pide ver el menú, ayuda, opciones o qué sabes hacer.
- music: si pide buscar, escuchar o descargar una canción (pon en QUERY el nombre de la canción y artista).
- pdf: si dice que quiere hacer/armar un PDF o escanear una tarea (pon en QUERY el nombre del archivo si lo mencionó, o déjalo vacío).
- sticker: si manda un enlace y pide hacerlo sticker (pon el link en QUERY).
- download_video: si manda un enlace y pide descargar el video (pon el link en QUERY).
- download_audio: si manda un enlace y pide solo el audio/mp3 (pon el link en QUERY).
- chat: para cualquier charla, ejemplo, explicación o pregunta normal.`;

const VALID_ACTIONS = new Set([
  'chat',
  'menu',
  'music',
  'pdf',
  'sticker',
  'download_video',
  'download_audio',
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
    chatModels.find((id) => /llama.*70b/i.test(id)) ||
    chatModels.find((id) => /llama|qwen|gemma|mixtral/i.test(id)) ||
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

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
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
