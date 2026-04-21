const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  history: [{
    role:    { type: String, enum: ["user", "assistant"] },
    content: { type: String },
  }],
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.BotConversation || mongoose.model("BotConversation", conversationSchema);
