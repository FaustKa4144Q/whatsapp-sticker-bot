export async function processWithAI(chatId, userText) {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw new Error('No detecto GROQ_API_KEY en Railway.');

  const model = await getBestGroqModel(apiKey);
  const history = histories.get(chatId) || [];
  history.push({ role: 'user', content: userText });
  if (history.length > 12) history.splice(0, history.length - 12);

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

  const rawText = data.choices?.[0]?.message?.content || '{}';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
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
