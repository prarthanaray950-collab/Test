const { chat }  = require("./openrouter");
const ctx       = require("./contextManager");
const api       = require("./websiteApi");
const admin     = require("./adminNotifier");

const extractBlock = (text, tag) => {
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`));
  if (!m) return null;
  const body = m[1];
  return {
    get: (key) => { const r = body.match(new RegExp(`${key}:\\s*(.+)`)); return r ? r[1].trim() : ""; },
    raw: body.trim(),
  };
};

const cleanReply = (text) =>
  text
    .replace(/\[ORDER_CONFIRMED\][\s\S]*?\[\/ORDER_CONFIRMED\]/g, "")
    .replace(/\[REGISTER_USER\][\s\S]*?\[\/REGISTER_USER\]/g, "")
    .replace(/\[SUBSCRIPTION_INTEREST\][\s\S]*?\[\/SUBSCRIPTION_INTEREST\]/g, "")
    .replace(/\[COMPLAINT\][\s\S]*?\[\/COMPLAINT\]/g, "")
    .replace(/\[HEALTH_NOTE\][\s\S]*?\[\/HEALTH_NOTE\]/g, "")
    .trim();

const cleanPhone = (jid) =>
  jid.replace("@s.whatsapp.net", "").replace(/^91/, "").replace(/\D/g, "").slice(-10);

const handleMessage = async (sock, phoneNumber, userText, pushName = "") => {
  console.log(`[IN]  ${phoneNumber}: ${userText.slice(0, 80)}`);

  try {
    const { history, profile } = await ctx.getHistoryAndProfile(phoneNumber);

    // Auto-save WhatsApp display name if profile has no name yet (Bug fix: pushName)
    if (pushName && !profile.name) {
      await ctx.updateProfile(phoneNumber, { name: pushName });
      profile.name = pushName;
      console.log(`[PROFILE] Auto-saved pushName: ${pushName}`);
    }

    await ctx.appendMessage(phoneNumber, "user", userText);

    const aiReply = await chat(userText, history, profile);
    console.log(`[AI]  ${aiReply.slice(0, 80)}`);

    let orderDone = false;

    // ── ORDER CONFIRMED ────────────────────────────────────────────────────────
    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    if (orderBlock) {
      const customerName = orderBlock.get("Name")    || profile.name    || "Unknown";
      const address      = orderBlock.get("Address") || profile.address || "";
      const item         = orderBlock.get("Item")    || "Tiffin";
      const amount       = parseInt(orderBlock.get("Amount").replace(/[^\d]/g, "")) || 0;

      try {
        await api.createOrder({
          phoneNumber:  phoneNumber.replace("@s.whatsapp.net", ""),
          customerName, address,
          items:       [{ name: item, quantity: 1, price: amount }],
          totalAmount:  amount,
          source:       "whatsapp_bot",
        });
        console.log(`[ORDER] ✅ ${customerName} Rs.${amount}`);
      } catch (e) {
        console.warn(`[ORDER] ⚠️ Website save failed: ${e.message}`);
      }

      await ctx.updateProfile(phoneNumber, { name: customerName, address });
      await ctx.recordOrder(phoneNumber);
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await ctx.clearHistory(phoneNumber);
      orderDone = true;
    }

    // ── REGISTER USER ──────────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name  = regBlock.get("Name")  || profile.name  || "Customer";
      const phone = regBlock.get("Phone") || cleanPhone(phoneNumber);
      const email = regBlock.get("Email") || profile.email || "";

      try {
        const result = await api.findOrCreateUser({ name, phone, email, source: "whatsapp_bot" });
        const userId = result?.user?._id || result?._id;
        if (userId) await ctx.updateProfile(phoneNumber, { name, email, linkedUserId: String(userId) });
        else        await ctx.updateProfile(phoneNumber, { name, email });
        console.log(`[USER] ✅ ${name} (${phone}) ${email}`);
      } catch (e) {
        console.warn(`[USER] ⚠️ ${e.message}`);
        await ctx.updateProfile(phoneNumber, { name, email });
      }

      await admin.notifyNewUser({ phoneNumber, name, phone });
    }

    // ── SUBSCRIPTION INTEREST ──────────────────────────────────────────────────
    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      const planName     = subBlock.get("Plan");
      const customerName = subBlock.get("Name")    || profile.name    || "";
      const address      = subBlock.get("Address") || profile.address || "";

      try {
        await api.createSubscriptionLead({ phoneNumber: phoneNumber.replace("@s.whatsapp.net", ""), customerName, planName, address, source: "whatsapp_bot" });
        console.log(`[SUB] ✅ ${planName}`);
      } catch (e) {
        console.warn(`[SUB] ⚠️ ${e.message}`);
      }

      await ctx.updateProfile(phoneNumber, {
        name:         customerName || undefined,
        address:      address      || undefined,
        lastPlanSeen: planName,
      });
      await admin.notifySubscriptionInterest({ phoneNumber, planName, customerName, address });
    }

    // ── COMPLAINT ──────────────────────────────────────────────────────────────
    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      const type  = compBlock.get("Type")  || "complaint";
      const issue = compBlock.get("Issue") || compBlock.raw;

      try {
        await api.submitComplaint({ phoneNumber: phoneNumber.replace("@s.whatsapp.net", ""), name: profile.name || "Unknown", type, issue, source: "whatsapp_bot" });
        console.log(`[COMPLAINT] ✅`);
      } catch (e) {
        console.warn(`[COMPLAINT] ⚠️ ${e.message}`);
      }

      await admin.notifyComplaint({ phoneNumber, type, issue });
    }

    // ── HEALTH NOTE ────────────────────────────────────────────────────────────
    const healthBlock = extractBlock(aiReply, "HEALTH_NOTE");
    if (healthBlock) {
      const note = healthBlock.get("Note") || healthBlock.raw;
      await ctx.updateProfile(phoneNumber, { healthNotes: note });
      await admin.notifyHealthNote({ phoneNumber, note });
      console.log(`[HEALTH] ✅`);
    }

    // Store cleaned reply (no [BLOCK] tags) so history doesn't confuse the AI on next turn
    if (!orderDone) await ctx.appendMessage(phoneNumber, "assistant", cleanReply(aiReply));

    const reply = cleanReply(aiReply);
    if (reply) {
      await sock.sendMessage(phoneNumber, { text: reply });
      console.log(`[OUT] ${reply.slice(0, 60)}`);
    }

  } catch (err) {
    console.error(`[ERR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(phoneNumber, {
      text: "Kuch technical issue aa gaya 😔 Thodi der mein try karein ya call karein: 6201276506",
    });
  }
};

module.exports = { handleMessage };
