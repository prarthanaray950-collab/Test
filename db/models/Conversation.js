const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  role:      { type: String, enum: ["user", "assistant"] },
  content:   { type: String },
  timestamp: { type: Date, default: Date.now },
});

const conversationSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true, index: true },
  history:     [messageSchema],

  profile: {
    name:              { type: String,  default: "" },
    phone:             { type: String,  default: "" },
    email:             { type: String,  default: "" },
    address:           { type: String,  default: "" },
    linkedUserId:      { type: String,  default: "" },
    totalOrders:       { type: Number,  default: 0 },
    lastOrderAt:       { type: Date },
    lastPlanSeen:      { type: String,  default: "" },
    healthNotes:       { type: String,  default: "" },
    adminNote:         { type: String,  default: "" },
    mealPreference:    { type: String,  default: "standard" }, // standard / sattvic / custom
    lastOrderItems:    { type: String,  default: "" },         // last ordered items (for reorder suggestion)
    lastFeedbackAt:    { type: Date },                         // last time we asked for feedback
    subscriptionEndAt: { type: Date },                         // for renewal reminders
    reminderSentAt:    { type: Date },                         // last reminder sent
    isTransferred:     { type: Boolean, default: false },      // currently talking to owner
    deliveryZone:      { type: String,  default: "" },         // approved / pending_approval / outside
    firstMessageSent:  { type: Boolean, default: false },      // welcome flow sent
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.BotConversation ||
  mongoose.model("BotConversation", conversationSchema);
