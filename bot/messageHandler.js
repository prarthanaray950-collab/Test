const { chat } = require("./openrouter");
const { getHistory, appendMessage, clearHistory } = require("./contextManager");
const Order = require("../db/models/Order");
const { createUser } = require("./userCreator");
const admin = require("./adminNotifier");

const extractBlock = (text, tag) => {
  const match = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`));
  if (!match) return null;
  const block = match[1];
  const getValue = (key) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  return { getValue };
};

const cleanReply = (text) =>
  text
    .replace(/\[ORDER_CONFIRMED\][\s\S]*?\[\/ORDER_CONFIRMED\]/g, "")
    .replace(/\[REGISTER_USER\][\s\S]*?\[\/REGISTER_USER\]/g, "")
    .replace(/\[COMPLAINT\][\s\S]*?\[\/COMPLAINT\]/g, "")
    .replace(/\[SUBSCRIPTION_INTEREST\][\s\S]*?\[\/SUBSCRIPTION_INTEREST\]/g, "")
    .trim();

const handleMessage = async (sock, phoneNumber, userText) => {
  console.log(`[MSG IN] ${phoneNumber}: ${userText}`);

  try {
    const history = await getHistory(phoneNumber);
    await appendMessage(phoneNumber, "user", userText);

    console.log("[Bot] Calling OpenRouter...");
    const aiReply = await chat(userText, history);
    console.log(`[Bot] Reply: ${aiReply.slice(0, 80)}`);

    // Handle ORDER
    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    let orderDone = false;
    if (orderBlock) {
      const customerName = orderBlock.getValue("Name") || "Unknown";
      const address      = orderBlock.getValue("Address") || "";
      const item         = orderBlock.getValue("Item") || "Unknown";
      const amount       = parseInt(orderBlock.getValue("Amount").replace(/[^\d]/g, "")) || 0;
      try {
        await Order.create({ phoneNumber, customerName, address, items: [item], totalAmount: amount, status: "pending" });
        console.log(`[Order] Saved: ${customerName} Rs.${amount}`);
      } catch (e) { console.error("[Order] Save error:", e.message); }
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await clearHistory(phoneNumber);
      orderDone = true;
    }

    // Handle REGISTER_USER
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name  = regBlock.getValue("Name") || "Customer";
      const phone = regBlock.getValue("Phone") || phoneNumber.replace("@s.whatsapp.net", "").replace(/^91/, "");
      const result = await createUser({ name, phone });
      if (result.success) {
        await admin.notifyNewUser({ phoneNumber, name, phone });
        console.log(`[User] Created: ${name}`);
      }
    }

    // Handle COMPLAINT
    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      await admin.notifyComplaint({ phoneNumber, issue: compBlock.getValue("Issue") });
    }

    // Handle SUBSCRIPTION_INTEREST
    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      await admin.notifySubscriptionInterest({ phoneNumber, planName: subBlock.getValue("Plan") });
    }

    if (!orderDone) await appendMessage(phoneNumber, "assistant", aiReply);

    const reply = cleanReply(aiReply);
    if (reply) {
      await sock.sendMessage(phoneNumber, { text: reply });
      console.log(`[MSG OUT] ${phoneNumber}: ${reply.slice(0, 60)}`);
    }

  } catch (err) {
    console.error(`[ERROR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(phoneNumber, {
      text: "Kuch technical issue aa gaya 😔 Thodi der baad try karein ya call karein: 6201276506",
    });
  }
};

module.exports = { handleMessage };
