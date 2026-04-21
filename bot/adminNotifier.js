const axios = require("axios");

let _sock = null;
const ADMIN    = () => process.env.ADMIN_WHATSAPP;
const TG_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = () => process.env.TELEGRAM_CHAT_ID;

const setSocket = (sock) => { _sock = sock; };

const wa = async (text) => {
  if (!_sock || !ADMIN()) return;
  try { await _sock.sendMessage(`${ADMIN()}@s.whatsapp.net`, { text }); }
  catch (e) { console.error("[Admin WA]", e.message); }
};

const tg = async (text) => {
  if (!TG_TOKEN() || !TG_CHAT()) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
      chat_id: TG_CHAT(),
      text: `[SatvikMeals Bot]\n\n${text}`,
    });
  } catch (e) { console.error("[Admin TG]", e.message); }
};

const notify = async (text) => Promise.allSettled([wa(text), tg(text)]);

const notifyNewOrder = async ({ phoneNumber, customerName, address, item, amount }) => {
  const phone = phoneNumber.replace("@s.whatsapp.net", "");
  await notify(`🆕 NEW ORDER\n\n👤 ${customerName}\n📱 ${phone}\n📍 ${address}\n🍱 ${item}\n💰 Rs. ${amount}\n\n✅ Awaiting UPI payment`);
};

const notifyNewUser = async ({ phoneNumber, name, phone }) => {
  const raw = phoneNumber.replace("@s.whatsapp.net", "");
  await notify(`👤 NEW USER\n\nName: ${name}\nPhone: ${phone || raw}`);
};

const notifySubscriptionInterest = async ({ phoneNumber, planName, customerName, address }) => {
  const phone = phoneNumber.replace("@s.whatsapp.net", "");
  await notify(`📋 SUBSCRIPTION INTEREST\n\n👤 ${customerName || "Unknown"}\n📱 ${phone}\n📍 ${address || "Not given"}\n📦 Plan: ${planName}`);
};

const notifyComplaint = async ({ phoneNumber, type, issue }) => {
  const phone = phoneNumber.replace("@s.whatsapp.net", "");
  await notify(`⚠️ ${(type || "COMPLAINT").toUpperCase()}\n\n📱 ${phone}\n\n${issue}`);
};

const notifyHealthNote = async ({ phoneNumber, note }) => {
  const phone = phoneNumber.replace("@s.whatsapp.net", "");
  await notify(`🏥 HEALTH NOTE\n\n📱 ${phone}\n\n${note}`);
};

const notifyBotOnline = () =>
  notify("🤖 SatvikMeals WhatsApp Bot ONLINE! 🌿\nBaileys connected, MongoDB session saved.");

module.exports = {
  setSocket, notify,
  notifyNewOrder, notifyNewUser,
  notifySubscriptionInterest, notifyComplaint,
  notifyHealthNote, notifyBotOnline,
};
