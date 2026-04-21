const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

let _menu = null, _menuAt = 0;
let _plans = null, _plansAt = 0;

const BASE = () => process.env.WEBSITE_API_URL || "https://satvikmeals.in";

const fetchJSON = async (path) => {
  const res = await fetch(`${BASE()}${path}`, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const getLiveMenu = async () => {
  if (_menu && Date.now() - _menuAt < CACHE_TTL) return _menu;
  try { _menu = await fetchJSON("/api/menu/current"); _menuAt = Date.now(); return _menu; }
  catch (e) { console.warn("[LiveData] Menu fetch failed:", e.message); return _menu; }
};

const getLivePlans = async () => {
  if (_plans && Date.now() - _plansAt < CACHE_TTL) return _plans;
  try { _plans = await fetchJSON("/api/plans"); _plansAt = Date.now(); return _plans; }
  catch (e) { console.warn("[LiveData] Plans fetch failed:", e.message); return _plans || []; }
};

const formatMenu = (data) => {
  if (!data?.items?.length) return "Iss hafte ka menu abhi available nahi hai. Call karein: 6201276506";
  const ORDER = ["Mon","Tue","Wed","Thu","Fri","Sat"];
  const items = data.items.filter(d => ORDER.includes(d.day)).sort((a,b) => ORDER.indexOf(a.day) - ORDER.indexOf(b.day));
  const lines = ["Is Hafte Ka Menu:\n"];
  for (const d of items) {
    lines.push(`${d.day}:`);
    if (d.lunchItems?.length)  lines.push(`  Lunch: ${d.lunchItems.join(", ")}`);
    if (d.dinnerItems?.length) lines.push(`  Dinner: ${d.dinnerItems.join(", ")}`);
  }
  return lines.join("\n");
};

const formatPlans = (plans) => {
  if (!plans?.length) return "Abhi koi active plan nahi hai. Call karein: 6201276506";
  return plans.map(p => `${p.name} — Rs. ${p.price}/${p.type}${p.description ? "\n   " + p.description : ""}`).join("\n\n");
};

module.exports = { getLiveMenu, getLivePlans, formatMenu, formatPlans };
