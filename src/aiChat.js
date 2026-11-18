const histories = new Map();
let cachedModel = null;

export function clearAIHistory(chatId) {
  histories.delete(chatId);
}

const SYSTEM_PROMPT = `Eres un asistente personal integrado en WhatsApp y Telegram. Hablas en español de forma natural, directa y relajada (respuestas cortas ideales para celular).
Analiza lo que pide el usuario y responde SIEMPRE con un JSON válido con esta estructura exacta:
{
  "action": "chat" | "menu" | "music" | "pdf" | "sticker" | "download_video" | "download_audio",
  "query": "texto extraído según la acción o vacío",
  "reply": "tu respuesta natural al usuario"
}

Reglas para elegir "action":
- "menu": si pide ver el menú, ayuda, opciones o qué sabes hacer.
- "music": si pide buscar, escuchar o descargar una canción (pon en "query" el nombre de la canción y artista).
- "pdf": si dice que quiere hacer/armar un PDF o escanear una tarea (pon en "query" el nombre del archivo si lo mencionó, o vacío).
- "sticker": si manda un enlace y pide hacerlo sticker (pon el link en "query").
- "download_video": si manda un enlace y pide descargar el video (pon el link en "query").
- "download_audio": si manda un enlace y pide solo el audio/mp3 (pon el link en "query").
- "chat": para cualquier otra charla, duda o comentario normal.`;

async function getBestGroqModel(apiKey) {
  if (cachedModel) return cachedModel;

  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Error listando modelos (${res.status})`);

  const chatModels = (data.data || [])
    .map((m) => m.id)
    .filter((id) => !/whisper|guard|tts|embed|vision/i.test(id));

  cachedModel =
    chatModels.find((id) => /llama.*70b/i.test(id)) ||
    chatModels.find((id) => /llama|qwen|gemma|mixtral/i.test(id)) ||
    chatModels[0];

  if (!cachedModel) throw new Error('No hay modelos de chat disponibles en tu cuenta de Groq.');
  return cachedModel;
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
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    cachedModel = null;
    throw new Error(data.error?.message || `Groq HTTP ${res.status}`);
  }

  const rawText = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { action: 'chat', query: '', reply: rawText };
  }

  const replyText = parsed.reply || 'Listo.';
  history.push({ role: 'assistant', content: replyText });
  histories.set(chatId, history);

  return {
    action: parsed.action || 'chat',
    query: (parsed.query || '').trim(),
    reply: replyText,
  };
}
