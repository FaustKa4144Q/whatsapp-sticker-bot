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

export async function processWithAI(chatId, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GEMINI_API_KEY en Railway.');
  }

  const history = histories.get(chatId) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: history,
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Error HTTP ${res.status}`);
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { action: 'chat', query: '', reply: rawText };
  }

  const replyText = parsed.reply || 'Listo.';
  history.push({ role: 'model', parts: [{ text: replyText }] });
  histories.set(chatId, history);

  return {
    action: parsed.action || 'chat',
    query: (parsed.query || '').trim(),
    reply: replyText,
  };
}
