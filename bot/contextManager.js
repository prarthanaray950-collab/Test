/**
 * contextManager.js
 *
 * Handles all conversation storage per phone number in MongoDB.
 * Every customer gets their own isolated document keyed by their
 * clean 10-digit phone number. Everything persists across restarts.
 */

const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 100;

// ── Phone normalization ───────────────────────────────────────────────────────
// Handles all formats: 919876543210@s.whatsapp.net, +919876543210, 9876543210
const normalizePhone = (raw) => {
  const digits = String(raw)
    .replace("@s.whatsapp.net", "")
    .replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  return digits.slice(1);
  return digits.slice(-10);
};

// ── Per-phone processing lock ────────────────────────────────────────────────
// Prevents two messages from the same person running concurrently.
// Lock is set when processing starts and ALWAYS cleared in the finally block.
// This is NOT a time-based block — it only blocks while a reply is actively
// being generated. Once the AI responds and the reply is sent, the lock is
// immediately released and the next message is processed normally.
const _processing = new Set();

const isAlreadyProcessing = (phoneNumber) => _processing.has(phoneNumber);
const markProcessingStart = (phoneNumber) => _processing.add(phoneNumber);
const markProcessingDone  = (phoneNumber) => _processing.delete(phoneNumber);

// ── Core read/write ───────────────────────────────────────────────────────────

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
 * Save user message and assistant reply together in one atomic write.
 * This prevents desync: if bot crashes mid-reply, both or neither are saved.
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
 * Update permanent profile. Only non-empty values are written.
 * Profile survives history trims and bot restarts completely.
 */
const updateProfile = async (phoneNumber, data = {}) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const set = { updatedAt: new Date() };
    if (data.name)         set["profile.name"]         = data.name;
    if (data.phone)        set["profile.phone"]        = data.phone;
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
 * Save WhatsApp display name ONLY if profile name is still empty.
 * Never overwrites a name the customer actually told us.
 */
const savePushNameIfNew = async (phoneNumber, pushName) => {
  if (!pushName) return;
  const phone = normalizePhone(phoneNumber);
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone, $or: [{ "profile.name": "" }, { "profile.name": null }] },
      {
        $set: { "profile.name": pushName, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[CTX] savePushNameIfNew error:", e.message);
  }
};

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
 * After a completed order, trim history to last 20 messages.
 * Profile is NEVER touched — customer never has to re-introduce themselves.
 */
const trimHistoryAfterOrder = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    if (!doc) return;
    const trimmed = doc.history.slice(-20);
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
  isAlreadyProcessing,
  markProcessingStart,
  markProcessingDone,
  getHistoryAndProfile,
  appendExchange,
  updateProfile,
  savePushNameIfNew,
  recordOrder,
  trimHistoryAfterOrder,
};
