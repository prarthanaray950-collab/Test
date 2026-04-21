const BASE   = () => (process.env.WEBSITE_API_URL || "https://satvikmeals.in").replace(/\/$/, "");
const SECRET = () => process.env.BOT_SECRET || "";

let _menuCache = null, _menuAt = 0;
let _planCache = null, _planAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

const apiFetch = async (path, options = {}) => {
  const res = await fetch(`${BASE()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-bot-secret": SECRET(),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status} ${path}: ${text.slice(0, 150)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

// ── READ (public routes, no secret needed) ────────────────────────────────────
const getLiveMenu = async () => {
  if (_menuCache && Date.now() - _menuAt < CACHE_TTL) return _menuCache;
  const data = await fetch(`${BASE()}/api/menu/current`).then(r => r.json());
  _menuCache = data; _menuAt = Date.now();
  return data;
};

const getLivePlans = async () => {
  if (_planCache && Date.now() - _planAt < CACHE_TTL) return _planCache;
  const data = await fetch(`${BASE()}/api/plans`).then(r => r.json());
  _planCache = data; _planAt = Date.now();
  return data;
};

// ── WRITE (bot-secret protected /api/bot/* routes) ────────────────────────────
const createOrder          = (p) => apiFetch("/api/bot/orders",        { method: "POST",  body: JSON.stringify(p) });
const updateOrderStatus    = (id, s) => apiFetch(`/api/bot/orders/${id}`, { method: "PATCH", body: JSON.stringify({ paymentStatus: s }) });
const getOrdersByPhone     = (ph) => apiFetch(`/api/bot/orders?phone=${encodeURIComponent(ph)}`);
const findOrCreateUser     = (p) => apiFetch("/api/bot/users",         { method: "POST",  body: JSON.stringify(p) });
const getUserByPhone       = (ph) => apiFetch(`/api/bot/users?phone=${encodeURIComponent(ph)}`);
const updateUser           = (id, d) => apiFetch(`/api/bot/users/${id}`, { method: "PATCH", body: JSON.stringify(d) });
const createSubscriptionLead = (p) => apiFetch("/api/bot/subscriptions", { method: "POST",  body: JSON.stringify(p) });
const submitComplaint      = (p) => apiFetch("/api/bot/complaint",     { method: "POST",  body: JSON.stringify(p) });
const updateMenuDay        = (id, d) => apiFetch(`/api/bot/menu/${id}`, { method: "PATCH", body: JSON.stringify(d) });
const createMenuWeek       = (d) => apiFetch("/api/bot/menu",          { method: "POST",  body: JSON.stringify(d) });
const createPlan           = (d) => apiFetch("/api/bot/plans",         { method: "POST",  body: JSON.stringify(d) });
const updatePlan           = (id, d) => apiFetch(`/api/bot/plans/${id}`, { method: "PATCH", body: JSON.stringify(d) });
const getDashboardStats    = () => apiFetch("/api/bot/admin/stats");

// ── Format helpers ────────────────────────────────────────────────────────────
const formatMenu = (data) => {
  if (!data?.items?.length) return "Is hafte ka menu abhi update nahi hua. Call: 6201276506";
  const ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = data.items
    .filter(d => ORDER.includes(d.day))
    .sort((a, b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day));
  const lines = [];
  for (const d of days) {
    lines.push(`${d.day}:`);
    if (d.breakfastItems?.length) lines.push(`  Breakfast: ${d.breakfastItems.join(", ")}`);
    if (d.lunchItems?.length)     lines.push(`  Lunch: ${d.lunchItems.join(", ")}`);
    if (d.dinnerItems?.length)    lines.push(`  Dinner: ${d.dinnerItems.join(", ")}`);
  }
  return lines.join("\n") || "Menu details available nahi hain. Call: 6201276506";
};

const formatPlans = (plans) => {
  if (!Array.isArray(plans) || !plans.length)
    return "Plans abhi available nahi. Call: 6201276506";
  return plans.map(p => {
    const features = p.features?.length ? `\n   Features: ${p.features.join(", ")}` : "";
    const meals    = p.meals?.length    ? ` | Meals: ${p.meals.join("+")}` : "";
    return `${p.name} (${p.type}) — Rs. ${p.price}${meals}${features}`;
  }).join("\n\n");
};

module.exports = {
  getLiveMenu, getLivePlans,
  createOrder, updateOrderStatus, getOrdersByPhone,
  findOrCreateUser, getUserByPhone, updateUser,
  createSubscriptionLead, submitComplaint,
  updateMenuDay, createMenuWeek,
  createPlan, updatePlan,
  getDashboardStats,
  formatMenu, formatPlans,
};
