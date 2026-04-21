const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 12;

const getHistory = async (phoneNumber) => {
  try {
    const convo = await Conversation.findOne({ phoneNumber });
    if (!convo || !convo.history.length) return [];
    return convo.history.slice(-HISTORY_LIMIT);
  } catch (err) {
    console.error("[Context] getHistory error:", err.message);
    return [];
  }
};

const appendMessage = async (phoneNumber, role, content) => {
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber },
      {
        $push: { history: { role, content } },
        $set:  { updatedAt: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("[Context] appendMessage error:", err.message);
  }
};

const clearHistory = async (phoneNumber) => {
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber },
      { $set: { history: [], updatedAt: new Date() } }
    );
  } catch (err) {
    console.error("[Context] clearHistory error:", err.message);
  }
};

module.exports = { getHistory, appendMessage, clearHistory };
