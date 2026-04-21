/**
 * messageHandler.js
 * 
 * Core message processing pipeline. For every incoming WhatsApp message:
 * 1. Normalize the phone number to a clean 10-digit format
 * 2. Load full conversation history + profile from MongoDB (persists across restarts)
 * 3. Save push name only if no real name is known yet
 * 4. Send full history + profile to AI so it has complete context
 * 5. Parse any structured action blocks ([REGISTER_USER], [SUBSCRIPTION_INTEREST] etc.)
 * 6. Save the user message AND assistant reply together (prevents desync on crash)
 * 7. Send reply to customer
 */

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

const handleMessage = async (sock, rawJid, userText, pushName = "") => {
  // Always normalize to clean 10-digit number for consistent DB keying
  const phoneNumber = ctx.normalizePhone(rawJid);
  console.log(`[IN]  ${phoneNumber} (${rawJid}): ${userText.slice(0, 80)}`);

  try {
    // ── STEP 1: Load full history + profile from MongoDB ──────────────────────
    // This is what makes the bot remember everything across restarts.
    // Every message ever sent by this customer is stored in MongoDB under
    // their phone number and retrieved fresh on every new message.
    const { history, profile } = await ctx.getHistoryAndProfile(phoneNumber);

    // ── STEP 2: Save WhatsApp display name only if no real name exists yet ────
    // We do NOT overwrite a name the customer already told us — only use the
    // WhatsApp display name as a fallback for brand new customers.
    if (pushName && !profile.name) {
      await ctx.savePushNameIfNew(phoneNumber, pushName);
      profile.name = pushName;
    }

    // ── STEP 3: Get AI reply — full history + profile sent every time ─────────
    // The AI receives the complete conversation history so it never forgets
    // what was discussed earlier in the session.
    const aiReply = await chat(userText, history, profile);
    console.log(`[AI]  ${phoneNumber}: ${aiReply.slice(0, 80)}`);

    // ── STEP 4: Save user message + assistant reply together in one write ──────
    // Saving both together prevents the desync bug: if the bot crashes after
    // saving the user message but before saving the reply, the AI would see
    // an orphaned user message with no reply on the next turn — confusing it.
    const cleanedReply = cleanReply(aiReply);
    await ctx.appendExchange(phoneNumber, userText, cleanedReply);

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
          phoneNumber,
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
      // Trim (not wipe) history after order — profile stays fully intact
      await ctx.trimHistoryAfterOrder(phoneNumber);
      orderDone = true;
    }

    // ── REGISTER USER ──────────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name  = regBlock.get("Name")  || profile.name  || "Customer";
      const phone = regBlock.get("Phone") || phoneNumber;
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
        await api.createSubscriptionLead({ phoneNumber, customerName, planName, address, source: "whatsapp_bot" });
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
        await api.submitComplaint({ phoneNumber, name: profile.name || "Unknown", type, issue, source: "whatsapp_bot" });
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

    // ── SEND REPLY ─────────────────────────────────────────────────────────────
    if (cleanedReply) {
      await sock.sendMessage(rawJid, { text: cleanedReply });
      console.log(`[OUT] ${phoneNumber}: ${cleanedReply.slice(0, 60)}`);
    }

  } catch (err) {
    console.error(`[ERR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(rawJid, {
      text: "Kuch technical issue aa gaya hai 🙏 Thodi der mein dobara try karein, ya seedha call karein: 6201276506",
    });
  }
};

module.exports = { handleMessage };
