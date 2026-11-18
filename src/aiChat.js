const histories = new Map();

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

async function callGroq(history) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Sin GROQ_API_KEY');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.text,
    })),
  ];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq HTTP ${res.status}`);
  return data.choices?.[0]?.message?.content || '{}';
}

async function callGemini(history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Sin GEMINI_API_KEY');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini HTTP ${res.status}`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
}

export async function processWithAI(chatId, userText) {
  const history = histories.get(chatId) || [];
  history.push({ role: 'user', text: userText });

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  let rawText;
  if (process.env.GROQ_API_KEY) {
    try {
      rawText = await callGroq(history);
    } catch (err) {
      if (process.env.GEMINI_API_KEY) rawText = await callGemini(history);
      else throw err;
    }
  } else {
    rawText = await callGemini(history);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { action: 'chat', query: '', reply: rawText };
  }

  const replyText = parsed.reply || 'Listo.';
  history.push({ role: 'model', text: replyText });
  histories.set(chatId, history);

  return {
    action: parsed.action || 'chat',
    query: (parsed.query || '').trim(),
    reply: replyText,
  };
}
