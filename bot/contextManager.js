/**
 * contextManager.js
 * 
 * Handles all conversation storage and retrieval per phone number.
 * Every customer gets their own isolated record in MongoDB, keyed by
 * their clean 10-digit phone number. All data — history, profile,
 * orders — persists across bot restarts because it lives in MongoDB,
 * not in memory.
 * 
 * Key design decisions:
 * - Phone numbers are ALWAYS normalized to 10 digits before any DB operation
 * - Profile (name, email, address etc.) is NEVER cleared — only history can be trimmed
 * - Messages are saved in pairs (user + assistant together) to prevent desync if bot crashes mid-reply
 * - History limit is 100 messages (50 full exchanges) — enough for full context
 * - pushName (WhatsApp display name) is ONLY saved if customer has never told the bot their real name
 */

const Conversation = require("../db/models/Conversation");

// 100 messages = 50 full back-and-forth turns — comprehensive memory per session
const HISTORY_LIMIT = 100;

/**
 * Normalize any phone number format to clean 10-digit Indian number.
 * Handles: 919876543210@s.whatsapp.net, 919876543210, 9876543210, +919876543210
 */
const normalizePhone = (raw) => {
  const digits = String(raw)
    .replace("@s.whatsapp.net", "")
    .replace(/\D/g, "");
  // Strip leading country code 91 if present and result would be 12 digits
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  return digits.slice(1);
  return digits.slice(-10); // always return last 10 digits
};

/**
 * Load conversation history and profile for a given phone number.
 * Returns empty defaults if this is a brand new customer.
 * History is trimmed to the most recent HISTORY_LIMIT messages so the
 * AI always has the latest context without exceeding token limits.
 */
const getHistoryAndProfile = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    return {
      history: doc?.history?.slice(-HISTORY_LIMIT) || [],
      profile: doc?.profile || {},
    };
  } catch (e) {
    console.error("[CTX] getHistoryAndProfile error:", e.message);
    return { history: [], profile: {} };
  }
};

/**
 * Save both the user message and the assistant reply together in one DB write.
 * This prevents the desync bug where a user message was saved but the bot
 * crashed before saving the reply — which would confuse the AI on next turn.
 * 
 * Both messages are appended atomically. If only the user message needs saving
 * (e.g. error path), pass null for assistantContent.
 */
const appendExchange = async (phoneNumber, userContent, assistantContent) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const messages = [{ role: "user", content: userContent, timestamp: new Date() }];
    if (assistantContent) {
      messages.push({ role: "assistant", content: assistantContent, timestamp: new Date() });
    }
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      {
        $push: { history: { $each: messages } },
        $set:  { updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("[CTX] appendExchange error:", e.message);
  }
};

/**
 * Update permanent profile fields for a customer.
 * Profile survives history trims and bot restarts.
 * Only non-empty values are written to avoid accidentally clearing data.
 */
const updateProfile = async (phoneNumber, data = {}) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const set = { updatedAt: new Date() };
    if (data.name)         set["profile.name"]         = data.name;
    if (data.email)        set["profile.email"]        = data.email;
    if (data.address)      set["profile.address"]      = data.address;
    if (data.linkedUserId) set["profile.linkedUserId"] = data.linkedUserId;
    if (data.lastPlanSeen) set["profile.lastPlanSeen"] = data.lastPlanSeen;
    if (data.healthNotes)  set["profile.healthNotes"]  = data.healthNotes;
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      { $set: set },
      { upsert: true }
    );
  } catch (e) {
    console.error("[CTX] updateProfile error:", e.message);
  }
};

/**
 * Save WhatsApp push name (display name) ONLY if the customer has never
 * told the bot their actual name. This prevents the display name from
 * overwriting a proper name the customer shared during registration or ordering.
 */
const savePushNameIfNew = async (phoneNumber, pushName) => {
  if (!pushName) return;
  const phone = normalizePhone(phoneNumber);
  try {
    // Only set name if profile.name is currently empty
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone, "profile.name": { $in: [null, ""] } },
      {
        $set: { "profile.name": pushName, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    console.log(`[CTX] Push name saved for ${phone}: ${pushName}`);
  } catch (e) {
    console.error("[CTX] savePushNameIfNew error:", e.message);
  }
};

/**
 * Increment order count and record last order timestamp.
 * Used after a confirmed order to track customer loyalty.
 */
const recordOrder = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      {
        $inc: { "profile.totalOrders": 1 },
        $set: { "profile.lastOrderAt": new Date(), updatedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[CTX] recordOrder error:", e.message);
  }
};

/**
 * Trim chat history to last 20 messages after a completed order,
 * but ALWAYS keep the full profile intact.
 * This prevents the AI context from getting stale after an order
 * while ensuring the customer never has to re-introduce themselves.
 */
const trimHistoryAfterOrder = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    if (!doc) return;
    const trimmed = doc.history.slice(-20); // keep last 20 messages
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      { $set: { history: trimmed, updatedAt: new Date() } }
    );
  } catch (e) {
    console.error("[CTX] trimHistoryAfterOrder error:", e.message);
  }
};

module.exports = {
  normalizePhone,
  getHistoryAndProfile,
  appendExchange,
  updateProfile,
  savePushNameIfNew,
  recordOrder,
  trimHistoryAfterOrder,
};
