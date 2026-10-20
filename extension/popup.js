const $ = (id) => document.getElementById(id);
const isExt = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
const DEFAULT_API = typeof OFFERGUARD_API !== "undefined" ? OFFERGUARD_API : "http://localhost:8787";
const ICON = { ok: "✅", warn: "⚠️", bad: "❌", info: "ℹ️" };
let api = isExt ? DEFAULT_API : location.origin;
let lastIds = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setPill(text, cls) { const p = $("pill"); p.textContent = text; p.className = "pill " + cls; }

async function pageSelection() {
  if (!isExt) return "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.getSelection().toString() });
    return ((r && r.result) || "").trim();
  } catch { return ""; }
}

async function checkHealth() {
  setPill("Connecting… free hosting can take up to a minute to wake", "wait");
  try {
    const j = await (await fetch(api + "/health", { cache: "no-store" })).json();
    setPill(j.tinyfish ? "Backend up · TinyFish key set" : "Backend up · TinyFish key missing", j.tinyfish ? "good" : "warn");
  } catch { setPill("Backend not reachable", "bad"); }
}

async function testTinyFish() {
  $("status").textContent = "Testing TinyFish Search and Fetch…";
  try {
    const j = await (await fetch(api + "/tinyfish-test", { cache: "no-store" })).json();
    if (j.error) { $("status").textContent = "TinyFish test: " + j.error; return; }
    const s = j.search && j.search.ok ? `Search OK (${j.search.results} results)` : `Search failed (${j.search && j.search.error})`;
    const f = j.fetch && j.fetch.ok ? `Fetch OK (${j.fetch.chars} chars)` : `Fetch failed (${j.fetch && j.fetch.error})`;
    $("status").textContent = `${j.ok ? "✅" : "⚠️"} ${s} · ${f}`;
  } catch { $("status").textContent = "Could not reach the backend."; }
}

function render(data) {
  lastIds = data.ids || [];
  const out = $("result");
  out.replaceChildren();

  const v = el("div", "verdict " + data.level);
  v.append(el("div", "v", data.verdict + (data.company ? " · " + data.company : "")));
  v.append(el("div", "n", data.note));
  out.append(v);

  data.evidence.forEach((e) => {
    const row = el("div", "ev");
    const t = el("div", "t", ICON[e.status] + " " + e.title);
    if (e.source === "tinyfish") t.append(el("span", "badge", "TinyFish"));
    row.append(t);
    if (e.detail) row.append(el("div", "d", e.detail));
    (e.links || []).forEach((l) => {
      if (/^https?:\/\//i.test(l.url)) {
        const a = el("a", "", l.title || l.url);
        a.href = l.url; a.target = "_blank"; a.rel = "noreferrer noopener";
        row.append(a);
      }
    });
    out.append(row);
  });

  if ((data.tinyfishTrace || []).length) {
    out.append(el("h3", "", "TinyFish activity"));
    const box = el("div", "ev");
    data.tinyfishTrace.forEach((c) => box.append(el("div", "trace", `${c.ok ? "✓" : "✗"} ${c.api} · ${c.detail.slice(0, 60)} · ${c.ms} ms${c.ok ? "" : " · " + c.error}`)));
    out.append(box);
  }

  out.append(el("h3", "", "Action kit"));
  data.kit.forEach((k) => {
    const d = el("details");
    d.append(el("summary", "", k.label));
    d.append(el("pre", "", k.text));
    const b = el("button", "ghost", "Copy");
    b.addEventListener("click", () => { navigator.clipboard.writeText(k.text); b.textContent = "Copied"; });
    d.append(b);
    out.append(d);
  });

  if (lastIds.length) {
    const r = el("button", "ghost", "Report as scam (warn the next student)");
    r.style.marginTop = "10px";
    r.addEventListener("click", async () => {
      try {
        const res = await fetch(api + "/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: lastIds, note: data.verdict }) });
        r.textContent = res.ok ? "Reported. Thank you." : "Could not report";
        r.disabled = true;
      } catch { r.textContent = "Could not reach backend"; }
    });
    out.append(r);
  }
}

async function verify() {
  const text = $("text").value.trim();
  if (!text) { $("status").textContent = "Paste or select the offer text first."; return; }
  $("verify").disabled = true;
  $("status").textContent = "Checking: local rules, domain age, and TinyFish live lookups…";
  $("result").replaceChildren();
  try {
    const res = await fetch(api + "/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, company: $("company").value.trim() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    $("status").textContent = "";
    render(data);
  } catch (e) {
    $("status").textContent = `Could not complete the check at ${api}. (${e.message})`;
  } finally { $("verify").disabled = false; }
}

(async function init() {
  document.body.classList.add(isExt ? "ext" : "web");
  if (isExt) {
    const saved = await chrome.storage.local.get("api");
    api = saved.api || DEFAULT_API;
    $("api").value = api;
    const sel = await pageSelection();
    if (sel) $("text").value = sel;
  } else { $("settings").hidden = true; }
  $("verify").addEventListener("click", verify);
  $("tftest").addEventListener("click", testTinyFish);
  $("grab").addEventListener("click", async () => { const s = await pageSelection(); if (s) $("text").value = s; else $("status").textContent = "No text selected on the page."; });
  $("saveApi").addEventListener("click", async () => { api = $("api").value.trim().replace(/\/$/, "") || DEFAULT_API; await chrome.storage.local.set({ api }); $("status").textContent = "Saved."; checkHealth(); });
  checkHealth();
})();
