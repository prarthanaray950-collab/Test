/**
 * messageHandler.js
 *
 * Core pipeline for every incoming WhatsApp message:
 * 1. Normalize phone, duplicate guard
 * 2. Load full history + profile from MongoDB
 * 3. Auto-store phone in profile
 * 4. Get AI reply
 * 5. If AI requests [FETCH_ACCOUNT] — fetch real data from website, retry with it
 * 6. Parse all action blocks and execute side effects
 * 7. Save exchange atomically, send reply
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
    found: true,
  };
};

const hasBlock = (text, tag) =>
  new RegExp(`\\[${tag}\\]`).test(text);

const cleanReply = (text) =>
  text
    .replace(/\[ORDER_CONFIRMED\][\s\S]*?\[\/ORDER_CONFIRMED\]/g, "")
    .replace(/\[REGISTER_USER\][\s\S]*?\[\/REGISTER_USER\]/g, "")
    .replace(/\[SUBSCRIPTION_INTEREST\][\s\S]*?\[\/SUBSCRIPTION_INTEREST\]/g, "")
    .replace(/\[COMPLAINT\][\s\S]*?\[\/COMPLAINT\]/g, "")
    .replace(/\[HEALTH_NOTE\][\s\S]*?\[\/HEALTH_NOTE\]/g, "")
    .replace(/\[FETCH_ACCOUNT\][\s\S]*?\[\/FETCH_ACCOUNT\]/g, "")
    .trim();

// Fetch live account data from the website API
const fetchAccountData = async (phoneNumber, profile) => {
  try {
    const [ordersRes, userRes] = await Promise.allSettled([
      api.getOrdersByPhone(phoneNumber),
      profile.linkedUserId
        ? api.getUserByPhone(phoneNumber)
        : Promise.resolve(null),
    ]);
    const orders = ordersRes.status === "fulfilled" ? (ordersRes.value?.orders || ordersRes.value || []) : [];
    const user   = userRes.status === "fulfilled"   ? userRes.value : null;
    return {
      totalOrders:    orders.length,
      activePlan:     user?.activePlan || user?.subscription?.plan || null,
      orders:         Array.isArray(orders) ? orders : [],
    };
  } catch (e) {
    console.error("[FETCH_ACCOUNT] Error:", e.message);
    return null;
  }
};

const handleMessage = async (sock, rawJid, userText, pushName = "") => {
  const phoneNumber = ctx.normalizePhone(rawJid);
  console.log(`[IN]  ${phoneNumber}: ${userText.slice(0, 80)}`);

  // ── Duplicate guard ────────────────────────────────────────────────────────
  if (ctx.isAlreadyProcessing(phoneNumber)) {
    console.warn(`[SKIP] ${phoneNumber}: duplicate blocked`);
    return;
  }
  ctx.markProcessingStart(phoneNumber);

  try {
    // ── Load history + profile ─────────────────────────────────────────────
    const { history, profile } = await ctx.getHistoryAndProfile(phoneNumber);

    // ── Auto-store phone in profile ────────────────────────────────────────
    if (!profile.phone) {
      await ctx.updateProfile(phoneNumber, { phone: phoneNumber });
      profile.phone = phoneNumber;
    }

    // ── Save push name only if no real name known ──────────────────────────
    if (pushName && !profile.name) {
      await ctx.savePushNameIfNew(phoneNumber, pushName);
      profile.name = pushName;
    }

    // ── First AI call ──────────────────────────────────────────────────────
    let aiReply = await chat(userText, history, profile, null);
    console.log(`[AI]  ${phoneNumber}: ${aiReply.slice(0, 100)}`);

    // ── Handle [FETCH_ACCOUNT] — fetch real data and retry ─────────────────
    if (hasBlock(aiReply, "FETCH_ACCOUNT")) {
      console.log(`[FETCH_ACCOUNT] Fetching live data for ${phoneNumber}`);
      const accountData = await fetchAccountData(phoneNumber, profile);
      // Retry AI with the real account data injected into the system prompt
      aiReply = await chat(userText, history, profile, accountData);
      console.log(`[AI RETRY] ${phoneNumber}: ${aiReply.slice(0, 100)}`);
    }

    const cleanedReply = cleanReply(aiReply);

    // ── Save exchange atomically ───────────────────────────────────────────
    await ctx.appendExchange(phoneNumber, userText, cleanedReply);

    let orderDone = false;

    // ── REGISTER USER ──────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name  = regBlock.get("Name")  || profile.name  || "Customer";
      const phone = regBlock.get("Phone") || profile.phone || phoneNumber;
      const email = regBlock.get("Email") || profile.email || "";

      console.log(`[USER] Registering: ${name} | ${phone} | ${email}`);
      try {
        const result = await api.findOrCreateUser({ name, phone, email, source: "whatsapp_bot" });
        const userId = result?.user?._id || result?._id || result?.user?.id;
        if (userId) {
          try { await api.updateUser(userId, { name, phone, email }); } catch (_) {}
          await ctx.updateProfile(phoneNumber, { name, phone, email, linkedUserId: String(userId) });
        } else {
          await ctx.updateProfile(phoneNumber, { name, phone, email });
        }
        console.log(`[USER] ✅ ${name} (${phone}) ${email}`);
      } catch (e) {
        console.warn(`[USER] ⚠️ ${e.message}`);
        await ctx.updateProfile(phoneNumber, { name, phone, email });
      }
      await admin.notifyNewUser({ phoneNumber, name, phone });
    }

    // ── ORDER CONFIRMED ────────────────────────────────────────────────────
    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    if (orderBlock) {
      const customerName = orderBlock.get("Name")    || profile.name    || "Unknown";
      const address      = orderBlock.get("Address") || profile.address || "";
      const item         = orderBlock.get("Item")    || "Tiffin";
      const amount       = parseInt(orderBlock.get("Amount").replace(/[^\d]/g, "")) || 0;
      try {
        await api.createOrder({ phoneNumber, customerName, address,
          items: [{ name: item, quantity: 1, price: amount }],
          totalAmount: amount, source: "whatsapp_bot" });
        console.log(`[ORDER] ✅ ${customerName} Rs.${amount}`);
      } catch (e) { console.warn(`[ORDER] ⚠️ ${e.message}`); }
      await ctx.updateProfile(phoneNumber, { name: customerName, address });
      await ctx.recordOrder(phoneNumber);
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await ctx.trimHistoryAfterOrder(phoneNumber);
      orderDone = true;
    }

    // ── SUBSCRIPTION INTEREST ──────────────────────────────────────────────
    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      const planName     = subBlock.get("Plan");
      const customerName = subBlock.get("Name")    || profile.name    || "";
      const address      = subBlock.get("Address") || profile.address || "";
      try {
        await api.createSubscriptionLead({ phoneNumber, customerName, planName, address, source: "whatsapp_bot" });
        console.log(`[SUB] ✅ ${planName}`);
      } catch (e) { console.warn(`[SUB] ⚠️ ${e.message}`); }
      await ctx.updateProfile(phoneNumber, {
        name: customerName || undefined,
        address: address   || undefined,
        lastPlanSeen: planName,
      });
      await admin.notifySubscriptionInterest({ phoneNumber, planName, customerName, address });
    }

    // ── COMPLAINT ──────────────────────────────────────────────────────────
    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      const type  = compBlock.get("Type")  || "complaint";
      const issue = compBlock.get("Issue") || compBlock.raw;
      try {
        await api.submitComplaint({ phoneNumber, name: profile.name || "Unknown", type, issue, source: "whatsapp_bot" });
        console.log(`[COMPLAINT] ✅`);
      } catch (e) { console.warn(`[COMPLAINT] ⚠️ ${e.message}`); }
      await admin.notifyComplaint({ phoneNumber, type, issue });
    }

    // ── HEALTH NOTE ────────────────────────────────────────────────────────
    const healthBlock = extractBlock(aiReply, "HEALTH_NOTE");
    if (healthBlock) {
      const note = healthBlock.get("Note") || healthBlock.raw;
      await ctx.updateProfile(phoneNumber, { healthNotes: note });
      await admin.notifyHealthNote({ phoneNumber, note });
      console.log(`[HEALTH] ✅`);
    }

    // ── Send reply ─────────────────────────────────────────────────────────
    if (cleanedReply) {
      await sock.sendMessage(rawJid, { text: cleanedReply });
      console.log(`[OUT] ${phoneNumber}: ${cleanedReply.slice(0, 80)}`);
    }

  } catch (err) {
    console.error(`[ERR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(rawJid, {
      text: "Kuch technical issue aa gaya hai 🙏 Thodi der mein dobara try karein, ya seedha call karein: 6201276506",
    });
  } finally {
    ctx.markProcessingDone(phoneNumber);
  }
};

module.exports = { handleMessage };
