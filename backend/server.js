// OfferGuard backend: Node 18+, zero dependencies.
// Local rules + domain age (RDAP) + TinyFish Search/Fetch + linked scam reports.
const http = require("http");
const fs = require("fs");
const path = require("path");

try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch {}

const PORT = process.env.PORT || 8787;
const TF_KEY = process.env.TINYFISH_API_KEY || "";
const USE_AGENT = process.env.USE_TINYFISH_AGENT === "1";

const FREE_MAIL = ["gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "rediffmail.com", "proton.me", "protonmail.com", "icloud.com", "live.com"];
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "cutt.ly", "rb.gy", "is.gd", "goo.gl", "shorturl.at"];
const AGG = ["linkedin.com", "glassdoor.com", "glassdoor.co.in", "indeed.com", "naukri.com", "internshala.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "wikipedia.org", "ambitionbox.com", "quora.com", "reddit.com", "crunchbase.com", "justdial.com", "mca.gov.in", "zaubacorp.com", "tofler.in", "thecompanycheck.com"];

const uniq = (a) => [...new Set(a)];
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
function rootDomain(host) {
  const p = (host || "").toLowerCase().replace(/^www\./, "").split(".");
  if (p.length <= 2) return p.join(".");
  const sl = ["co", "org", "ac", "net", "gov", "edu", "com"];
  const n = p[p.length - 1].length === 2 && sl.includes(p[p.length - 2]) ? 3 : 2;
  return p.slice(-n).join(".");
}

// ---------- extraction ----------
function extract(text, companyHint) {
  const emails = uniq((text.match(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((s) => s.toLowerCase()));
  const upis = uniq((text.match(/[\w.-]{2,}@[a-z]{2,15}(?![\w-]|\.[a-z])/gi) || []).map((s) => s.toLowerCase()));
  const links = uniq((text.match(/https?:\/\/[^\s<>"')]+/gi) || []).map((u) => u.replace(/[.,;]+$/, "")));
  const phones = uniq((text.match(/(?:\+?91[\s-]?)?[6-9]\d{9}\b/g) || []).map((p) => p.replace(/\D/g, "").slice(-10)));
  const fees = [];
  for (const m of text.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]{2,})/gi)) fees.push(parseInt(m[1].replace(/,/g, ""), 10));
  let company = (companyHint || "").trim();
  if (!company) {
    const suffix = "(?:Pvt\\.?\\s*Ltd\\.?|Private Limited|Limited|Ltd\\.?|LLP|Technologies|Solutions|Labs|Infotech|Systems|Software|Services)";
    const m1 = text.match(new RegExp("([A-Z][\\w&.-]*(?:\\s+[A-Z][\\w&.-]*){0,3}\\s+" + suffix + ")"));
    const m2 = text.match(/\b(?:at|with|from|join)\s+([A-Z][\w&.-]+(?:\s+[A-Z][\w&.-]+){0,2})/);
    company = m1 ? m1[1].trim() : m2 ? m2[1].trim() : "";
  }
  const senderDomains = uniq(emails.map((e) => e.split("@")[1]));
  const corpRoots = uniq([...senderDomains.filter((d) => !FREE_MAIL.includes(d)), ...links.map(hostOf).filter((h) => h && !SHORTENERS.includes(h))].map(rootDomain));
  return { emails, upis, links, phones, fees, company, senderDomains, corpRoots };
}

// ---------- linked reports ----------
const REPORTS_FILE = path.join(__dirname, "reports.json");
const SEED_FILE = path.join(__dirname, "seed-reports.json");
let reports = [];
try { reports = JSON.parse(fs.readFileSync(fs.existsSync(REPORTS_FILE) ? REPORTS_FILE : SEED_FILE, "utf8")); } catch { reports = []; }
const saveReports = () => fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2));
const idsOf = (x) => [
  ...x.upis.map((u) => "upi:" + u),
  ...x.phones.map((p) => "phone:" + p),
  ...x.corpRoots.map((d) => "domain:" + d),
  ...x.emails.filter((e) => FREE_MAIL.includes(e.split("@")[1])).map((e) => "email:" + e),
];

// ---------- domain age via RDAP ----------
async function domainAgeDays(root) {
  const r = await fetch("https://rdap.org/domain/" + root, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("rdap " + r.status);
  const j = await r.json();
  const ev = (j.events || []).find((e) => e.eventAction === "registration");
  if (!ev) throw new Error("no registration date");
  return Math.floor((Date.now() - new Date(ev.eventDate).getTime()) / 86400000);
}

// ---------- TinyFish ----------
const SEARCH_URL = process.env.TF_SEARCH_URL || "https://api.search.tinyfish.ai/";
const FETCH_URL = process.env.TF_FETCH_URL || "https://api.fetch.tinyfish.ai";
const AGENT_URL = process.env.TF_AGENT_URL || "https://agent.tinyfish.ai/v1/automation/run";
const tfHeaders = () => ({ "X-API-Key": TF_KEY });

// Records every TinyFish call (API, input, time, success) so the UI can show real usage.
async function traced(trace, api, detail, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    if (trace) trace.push({ api, detail, ok: true, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    if (trace) trace.push({ api, detail, ok: false, ms: Date.now() - t0, error: e.message });
    throw e;
  }
}
const tfSearch = (query, trace) => traced(trace, "Search", query, async () => {
  const r = await fetch(SEARCH_URL + "?query=" + encodeURIComponent(query), { headers: tfHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("TinyFish Search " + r.status);
  return (await r.json()).results || [];
});
const tfFetch = (urls, trace) => traced(trace, "Fetch", urls.join(", "), async () => {
  const r = await fetch(FETCH_URL, {
    method: "POST",
    headers: { ...tfHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ urls, format: "markdown" }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("TinyFish Fetch " + r.status);
  return r.json(); // { results: [{url, final_url, text, ...}], errors: [] }
});
// Experimental: goal-based Agent call. Check the TinyFish Agent docs for the exact schema.
const tfAgent = (url, goal, trace) => traced(trace, "Agent", url, async () => {
  const r = await fetch(AGENT_URL, {
    method: "POST",
    headers: { ...tfHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ url, goal }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error("TinyFish Agent " + r.status);
  return r.json();
});

const SENSITIVE = [
  [/aadhaar|aadhar/i, "Aadhaar"], [/\bpan\b/i, "PAN"], [/bank account|account number|ifsc/i, "bank details"],
  [/\botp\b/i, "OTP"], [/password|cvv|card number/i, "card or password"], [/\bpay(ment)?\b|\bfee\b|₹|\bupi\b/i, "payment"],
];

async function tinyfishChecks(x, add, trace) {
  const company = x.company;
  const jobs = [];

  if (company) {
    jobs.push((async () => {
      try {
        const res = (await tfSearch(`"${company}" internship scam fraud fake offer`, trace)).slice(0, 8);
        const tok = company.toLowerCase().split(/\s+/)[0];
        const hits = res.filter((r) => { const t = `${r.title} ${r.snippet}`.toLowerCase(); return t.includes(tok) && /scam|fraud|fake|cheat|complaint|warning/.test(t); });
        const links = hits.slice(0, 3).map((r) => ({ title: r.title, url: r.url }));
        if (hits.length >= 2) add("warn", "Scam-related results mention this company", `${hits.length} of the top search results mention scams or fraud alongside this name. Read them before deciding.`, 2, "tinyfish", links);
        else if (hits.length === 1) add("warn", "One scam-related result mentions this company", "Worth a quick read before you proceed.", 1, "tinyfish", links);
        else add("ok", "No scam-related results in top search results", "A weak signal only. It does not prove the offer is genuine.", 0, "tinyfish");
      } catch (e) { add("info", "Reputation search unavailable", e.message, 0, "tinyfish"); }
    })());

    jobs.push((async () => {
      let official = null;
      try {
        const res = await tfSearch(`${company} official website`, trace);
        const hit = res.find((r) => { const h = rootDomain(hostOf(r.url)); return h && !AGG.includes(h); });
        if (!hit) { add("info", "Could not find the company’s official site", "Try adding the exact company name.", 0, "tinyfish"); return; }
        official = hit.url;
        const oroot = rootDomain(hostOf(hit.url));
        const lk = [{ title: hit.title, url: hit.url }];
        if (x.corpRoots.length && x.corpRoots.includes(oroot)) add("ok", `Offer domain matches the likely official site (${oroot})`, "", 0, "tinyfish", lk);
        else if (x.corpRoots.length) add("warn", "Offer domain does not match the likely official site", `Offer uses ${x.corpRoots.join(", ")}; search suggests ${oroot}. Confirm on the company’s own website.`, 2, "tinyfish", lk);
        else add("info", `Likely official site: ${oroot}`, "Compare it with where the offer came from.", 0, "tinyfish", lk);
      } catch (e) { add("info", "Official-site search unavailable", e.message, 0, "tinyfish"); return; }

      try {
        const j = await tfFetch([official], trace);
        const page = (j.results || [])[0];
        if (page) {
          const mentions = /career|intern|jobs|hiring|join us/i.test(page.text || "");
          add(mentions ? "ok" : "info", mentions ? "Official site mentions careers or internships" : "No careers mention on the official homepage", "Read via TinyFish Fetch. Confirm the specific role on their careers page.", 0, "tinyfish");
        }
      } catch (e) { add("info", "Official-site fetch unavailable", e.message, 0, "tinyfish"); }

      if (USE_AGENT) {
        try {
          const out = await tfAgent(official, `Find this company's careers or internships page and say whether the role mentioned in the offer is listed. Return short JSON.`, trace);
          add("info", "TinyFish Agent careers check (experimental)", JSON.stringify(out).slice(0, 300), 0, "tinyfish");
        } catch (e) { add("info", "TinyFish Agent check unavailable", e.message, 0, "tinyfish"); }
      }
    })());
  }

  const toPreview = x.links.slice(0, 2);
  if (toPreview.length) {
    jobs.push((async () => {
      try {
        const j = await tfFetch(toPreview, trace);
        for (const page of j.results || []) {
          const found = SENSITIVE.filter(([re]) => re.test(page.text || "")).map(([, l]) => l);
          const lk = [{ title: page.url, url: page.url }];
          if (found.length) add("bad", `Linked page asks for: ${found.join(", ")}`, "Previewed safely through TinyFish, so you never had to open it.", 3, "tinyfish", lk);
          else add("ok", "Linked page previewed safely", "No sensitive requests found in its visible text.", 0, "tinyfish", lk);
        }
        for (const e of j.errors || []) add("info", "Could not preview a link", `${e.url}: ${e.error}`, 0, "tinyfish");
      } catch (e) { add("info", "Link preview unavailable", e.message, 0, "tinyfish"); }
    })());
  }
  await Promise.all(jobs);
}

// ---------- main verification ----------
async function verify(text, companyHint) {
  const x = extract(text, companyHint);
  const ev = [];
  const trace = [];
  const add = (status, title, detail = "", points = 0, source = "local", links = []) =>
    ev.push({ status, title, detail, points: status === "ok" || status === "info" ? 0 : points, source, links });

  const free = x.senderDomains.filter((d) => FREE_MAIL.includes(d));
  if (free.length) add("bad", `Sent from a free email address (${free.join(", ")})`, "Companies normally write from their own domain.", 2);
  else if (x.emails.length) add("ok", `Company email domain used (${x.senderDomains.join(", ")})`);
  else add("info", "No email address found in the text");

  const feeWords = /(registration|security|refundable|training|processing|onboarding|joining|verification|kit|laptop|certificate)\s+(fee|fees|charge|charges|deposit|amount)|\bdeposit\b|pay\s+(₹|rs|inr)/i;
  const payDemand = feeWords.test(text) || (x.fees.length > 0 && /pay|fee|deposit|transfer/i.test(text));
  if (payDemand) add("bad", "Asks you to pay money", `Genuine internships and jobs do not charge candidates.${x.fees.length ? " Amount mentioned: ₹" + x.fees[0] + "." : ""}`, 5);
  else add("ok", "No payment demand detected");

  if (x.upis.length) add(payDemand ? "bad" : "warn", `Payment to a UPI ID: ${x.upis[0]}`, "Check that the payee name matches a registered company before any payment.", payDemand ? 2 : 1);

  if (/\botp\b|\bcvv\b|\bpin\b|password/i.test(text)) add("bad", "Asks for an OTP, PIN, or password", "No recruiter needs these.", 3);
  else if (/aadhaar|aadhar|pan card|bank (account|details)|passbook|cancelled cheque/i.test(text)) add("warn", "Asks for ID or bank details early", "Share these only after verifying the employer.", 2);
  else add("ok", "No ID or credential request detected");

  if (/(within|in)\s+\d+\s*(hours|hrs|minutes)|immediately|last chance|limited seats|today only|urgent/i.test(text)) add("warn", "Pressure and urgency language", "Scams rush you so you skip verification.", 1);
  if (/whatsapp|telegram|wa\.me|t\.me/i.test(text)) add("warn", "Moves the conversation to WhatsApp or Telegram", "Genuine hiring usually uses official email.", 1);
  if (x.links.some((l) => SHORTENERS.includes(hostOf(l)))) add("warn", "Shortened link hides the real destination", "", 1);

  if (x.company && x.corpRoots.length) {
    const tok = x.company.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/)[0];
    if (tok.length > 2 && !x.corpRoots.some((d) => d.includes(tok))) add("warn", "Email or link domain does not contain the company name", `Company: ${x.company}. Domains: ${x.corpRoots.join(", ")}.`, 1);
  }

  await Promise.all(x.senderDomains.filter((d) => !FREE_MAIL.includes(d)).slice(0, 2).map(async (d) => {
    const root = rootDomain(d);
    try {
      const days = await domainAgeDays(root);
      if (days < 180) add("bad", `Domain ${root} was registered ${days} days ago`, "Very new domains are a common scam sign.", 3, "rdap");
      else if (days < 365) add("warn", `Domain ${root} is under a year old`, "", 1, "rdap");
      else add("ok", `Domain ${root} registered ${Math.floor(days / 365)}+ years ago`, "", 0, "rdap");
    } catch { add("info", `Could not check the age of ${root}`, "", 0, "rdap"); }
  }));

  const ids = idsOf(x);
  const linked = ids.filter((id) => reports.filter((r) => r.ids.includes(id)).length > 0)
    .map((id) => ({ id, n: reports.filter((r) => r.ids.includes(id)).length }));
  if (linked.length) add("bad", "Seen in earlier scam reports", linked.map((l) => `${l.id} (${l.n} report${l.n > 1 ? "s" : ""})`).join(", "), 4, "reports");

  if (TF_KEY) await tinyfishChecks(x, add, trace);
  else add("info", "TinyFish live checks skipped", "Set TINYFISH_API_KEY in backend/.env to enable Search, Fetch, and link preview.", 0, "tinyfish");

  const score = ev.reduce((s, e) => s + e.points, 0);
  const level = score >= 5 ? "high" : score >= 2 ? "verify" : "ok";
  const verdict = { high: "High risk", verify: "Verify first", ok: "No major red flags found" }[level];
  const order = { bad: 0, warn: 1, ok: 2, info: 3 };
  ev.sort((a, b) => order[a.status] - order[b.status]);
  return { company: x.company, extracted: x, ids, evidence: ev, score, level, verdict, kit: buildKit(x), tinyfishTrace: trace, note: "Risk indicators, not proof. Always confirm through the company’s official channels." };
}

function buildKit(x) {
  const who = x.company || "your company";
  const sender = x.emails.length ? ` (sent from ${x.emails.join(", ")})` : "";
  return [
    { label: "Email to the company’s official HR", text: `Subject: Please confirm an internship/job offer\n\nHello,\n\nI received an offer that appears to be from ${who}${sender}. Before I proceed, could you please confirm whether this offer was issued by your company and share the official joining process? I have not made any payment or shared documents.\n\nThank you,\n[Your name]\n\n(Send this to the HR address listed on the company’s own website, not the one in the offer.)` },
    { label: "Message to your placement cell", text: `Hello, I received an offer from ${who}${sender} that shows possible scam signs${x.fees.length ? " (it asks for ₹" + x.fees[0] + ")" : ""}. Could you check if this company is known to the placement cell before students respond?` },
    { label: "Summary for a cybercrime report", text: `Suspected fake job/internship offer.\nCompany named: ${who}\nEmails: ${x.emails.join(", ") || "none"}\nUPI IDs: ${x.upis.join(", ") || "none"}\nPhones: ${x.phones.join(", ") || "none"}\nLinks: ${x.links.join(", ") || "none"}\nAmount demanded: ${x.fees.length ? "₹" + x.fees[0] : "none"}\n\nReport at cybercrime.gov.in, or call the national helpline 1930 if you have already paid.` },
  ];
}

// ---------- HTTP ----------
const EXT_DIR = path.join(__dirname, "..", "extension");
const STATIC = {
  "/": ["popup.html", "text/html; charset=utf-8"],
  "/popup.css": ["popup.css", "text/css"],
  "/popup.js": ["popup.js", "text/javascript"],
  "/config.js": ["config.js", "text/javascript"],
};
const hits = new Map();
function limited(req) { // simple per-IP limit: 20 requests per 10 minutes
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 600000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  res.end(JSON.stringify(obj));
}
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 200000) { reject(new Error("too large")); req.destroy(); } });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch (e) { reject(e); } });
});

// One Search call and one Fetch call, so you can confirm the integration works after deploying.
async function tinyfishSelfTest() {
  if (!TF_KEY) return { ok: false, error: "TINYFISH_API_KEY is not set on the server." };
  const trace = [];
  const out = { ok: true, search: null, fetch: null, trace };
  try { const r = await tfSearch("TinyFish web agents", trace); out.search = { ok: true, results: r.length }; }
  catch (e) { out.ok = false; out.search = { ok: false, error: e.message }; }
  try { const j = await tfFetch(["https://example.com"], trace); out.fetch = { ok: true, chars: (((j.results || [])[0] || {}).text || "").length }; }
  catch (e) { out.ok = false; out.fetch = { ok: false, error: e.message }; }
  return out;
}

if (require.main === module) {
  http.createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "OPTIONS") return send(res, 204, {});
    try {
      if (req.method === "GET" && STATIC[url]) {
        const [file, type] = STATIC[url];
        res.writeHead(200, { "Content-Type": type });
        return res.end(fs.readFileSync(path.join(EXT_DIR, file)));
      }
      if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true, tinyfish: !!TF_KEY, agent: USE_AGENT, reports: reports.length });
      if (req.method === "GET" && url === "/tinyfish-test") {
        if (limited(req)) return send(res, 429, { error: "Too many requests. Try again in a few minutes." });
        return send(res, 200, await tinyfishSelfTest());
      }
      if (req.method === "POST" && url === "/verify") {
        if (limited(req)) return send(res, 429, { error: "Too many requests. Try again in a few minutes." });
        const b = await readBody(req);
        if (!b.text || !String(b.text).trim()) return send(res, 400, { error: "text is required" });
        return send(res, 200, await verify(String(b.text).slice(0, 5000), String(b.company || "").slice(0, 100)));
      }
      if (req.method === "POST" && url === "/report") {
        const b = await readBody(req);
        const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x) => typeof x === "string").slice(0, 20);
        if (!ids.length) return send(res, 400, { error: "no identifiers to report" });
        reports.push({ ids, note: String(b.note || "").slice(0, 200), ts: new Date().toISOString() });
        saveReports();
        return send(res, 200, { ok: true, reports: reports.length });
      }
      send(res, 404, { error: "not found" });
    } catch (e) { send(res, 500, { error: e.message }); }
  }).listen(PORT, () => console.log(`OfferGuard on http://localhost:${PORT}  (TinyFish ${TF_KEY ? "key set" : "NOT set: add TINYFISH_API_KEY"})`));
}
module.exports = { verify, extract };
