const histories = new Map();

export function clearAIHistory(chatId) {
  histories.delete(chatId);
}

export async function askAI(chatId, userText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GEMINI_API_KEY en Railway.');
  }

  const history = histories.get(chatId) || [];
  history.push({ role: 'user', parts: [{ text: userText }] });

  // Mantiene los últimos 12 mensajes para recordar el hilo sin saturar
  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: 'Eres un asistente integrado en un bot de WhatsApp y Telegram. Responde en español, de forma natural, directa y concisa (ideal para leer rápido en el celular).',
            },
          ],
        },
        contents: history,
      }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Error HTTP ${res.status}`);
  }

  const reply =
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    'No pude generar una respuesta.';

  history.push({ role: 'model', parts: [{ text: reply }] });
  histories.set(chatId, history);

  return reply;
}
