/**
 * openrouter.js
 *
 * AI chat with:
 * - 20-second hard timeout on every request
 * - Automatic retry on a faster fallback model if primary times out or fails
 * - Graceful error message if both fail (never hangs silently)
 *
 * Model priority:
 *   1. OPENROUTER_MODEL env var (if set)
 *   2. Primary:  meta-llama/llama-3.3-70b-instruct:free
 *   3. Fallback: mistralai/mistral-7b-instruct:free  (faster, lighter)
 *   4. Fallback: qwen/qwen-2-7b-instruct:free        (last resort)
 */

const getSystemPrompt = require("./systemPrompt");

const TIMEOUT_MS  = 15000; // 15 seconds per attempt
const FALLBACKS   = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "mistralai/mistral-small:free",
  "qwen/qwen-2-7b-instruct:free",
];

/**
 * Make one attempt to the OpenRouter API with a hard timeout.
 * Throws if timeout exceeded or response is not ok.
 */
const attemptChat = async (apiKey, model, messages) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://satvikmeals.in",
        "X-Title":       "SatvikMeals WhatsApp Bot",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens:  700,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 150)}`);

    const data = JSON.parse(raw);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from model");

    return text;

  } finally {
    clearTimeout(timer);
  }
};

const chat = async (userMessage, history = [], profile = {}, accountData = null, isNewUser = false) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith("sk-or-v1-xxx")) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const systemPrompt = await getSystemPrompt(profile, accountData, isNewUser);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user",   content: userMessage },
  ];

  // Build model list: env override first, then fallbacks
  const envModel = process.env.OPENROUTER_MODEL;
  const models = envModel
    ? [envModel, ...FALLBACKS.filter(m => m !== envModel)]
    : FALLBACKS;

  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      console.log(`[AI] Attempt ${i + 1}/${models.length} — model: ${model} | history: ${history.length} | profile: ${!!profile.name}`);
      const reply = await attemptChat(apiKey, model, messages);
      console.log(`[AI] ✅ Reply from ${model} — ${reply.length} chars`);
      return reply;
    } catch (e) {
      lastError = e;
      const reason = e.name === "AbortError" ? "TIMEOUT" : e.message.slice(0, 80);
      console.warn(`[AI] ❌ ${model} failed: ${reason}`);
      // Small delay before trying next model
      if (i < models.length - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }

  // All models failed — throw so messageHandler sends the friendly error message
  throw new Error(`All models failed. Last error: ${lastError?.message}`);
};

module.exports = { chat };
