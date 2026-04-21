const getSystemPrompt = require("./systemPrompt");

const chat = async (userMessage, history = []) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes("xxxx")) {
    throw new Error("OPENROUTER_API_KEY not set in environment variables");
  }

  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-8b-instruct:free";
  const systemPrompt = await getSystemPrompt();

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  console.log(`[OpenRouter] Calling model: ${model}`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://satvikmeals.in",
      "X-Title": "SatvikMeals WhatsApp Bot",
    },
    body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.75 }),
  });

  const rawBody = await response.text();
  console.log(`[OpenRouter] Status: ${response.status}`);

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${rawBody.slice(0, 200)}`);
  }

  const data = JSON.parse(rawBody);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`Empty reply. Response: ${rawBody.slice(0, 200)}`);

  console.log(`[OpenRouter] ✅ Reply (${text.length} chars)`);
  return text;
};

module.exports = { chat };
