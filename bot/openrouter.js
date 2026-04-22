const getSystemPrompt = require("./systemPrompt");

const chat = async (userMessage, history = [], profile = {}, accountData = null) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-or-v1-xxx")) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
  // Pass accountData into systemPrompt so live account info is injected when available
  const systemPrompt = await getSystemPrompt(profile, accountData);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user",   content: userMessage },
  ];

  console.log(`[AI] model=${model} history=${history.length} hasProfile=${!!profile.name} hasAccountData=${!!accountData}`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  "https://satvikmeals.in",
      "X-Title":       "SatvikMeals WhatsApp Bot",
    },
    body: JSON.stringify({ model, messages, max_tokens: 700, temperature: 0.35 }),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${raw.slice(0, 200)}`);

  const data = JSON.parse(raw);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Empty AI reply. Raw: ${raw.slice(0, 200)}`);

  console.log(`[AI] Reply ${text.length} chars`);
  return text;
};

module.exports = { chat };
