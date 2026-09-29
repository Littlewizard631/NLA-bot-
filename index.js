// New NFT projects (collections) on OpenSea, Robinhood Chain only -> Telegram
// No dependencies. Node 18+.
// Env: OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
// Optional: POLL_MINUTES (default 5), HEARTBEAT_HOURS (default 24), CHAIN_ID (skip auto-detect)
import process from "node:process";

const { OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const POLL_MS = (Number(process.env.POLL_MINUTES) || 5) * 60 * 1000;
const HEARTBEAT_MS = (Number(process.env.HEARTBEAT_HOURS) || 24) * 3600 * 1000;
const API = "https://api.opensea.io/api/v2";
// Filters
const REQUIRE = (process.env.REQUIRE_LINKS || "both").toLowerCase();       // "both" = X and website, "any" = either
const PENDING_MS = (Number(process.env.PENDING_HOURS) || 24) * 3600 * 1000; // keep re-checking new projects this long
const RECHECK_MS = 20 * 60 * 1000;
const EXCLUDE = (process.env.EXCLUDE_CONTRACTS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);

if (!OPENSEA_API_KEY || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Set OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function tg(html) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: html, parse_mode: "HTML" }),
    });
    if (!res.ok) console.error("Telegram", res.status, await res.text());
  } catch (e) { console.error("Telegram", e.message); }
  await sleep(1100); // stay under Telegram's rate limit
}

async function os(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { "x-api-key": OPENSEA_API_KEY, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Find OpenSea's identifier for Robinhood Chain
async function resolveChain() {
  if (process.env.CHAIN_ID) return process.env.CHAIN_ID;
  const { chains = [] } = await os("/chains");
  const hit = chains.find(c => /robinhood/i.test(`${c.chain} ${c.name}`));
  if (!hit) throw new Error("Robinhood Chain not found in OpenSea /chains list. Set CHAIN_ID manually.");
  return hit.chain;
}

const fetchNewest = (chain, limit = 100) =>
  os(`/collections?chain=${encodeURIComponent(chain)}&order_by=created_date&limit=${limit}`)
    .then(d => d.collections || []);

const seen = new Set();
const pending = new Map();   // slug -> { c, first, last }: new projects waiting to pass the filters
let checks = 0, found = 0, failures = 0, failAlerted = false;

const isUrl = x => /^https?:\/\/\S+\.\S+/i.test(String(x || "").trim());
const handle = c => String(c.twitter_username || "").replace(/^@/, "").trim();

// Returns { status: "pass" | "wait" | "drop", c }
async function evaluate(c) {
  // Fetch full profile if the list response lacked link fields
  if (!("twitter_username" in c) && !("project_url" in c)) {
    try { c = { ...c, ...(await os(`/collections/${c.collection}`)) }; } catch (e) { console.error(e.message); }
  }
  // Permanent rejects: USDG-named or excluded contracts
  if (/usdg/i.test(`${c.name} ${c.collection}`)) return { status: "drop", c };
  if ((c.contracts || []).some(k => EXCLUDE.includes(String(k.address).toLowerCase()))) return { status: "drop", c };

  // Needs X and/or website on the profile (may be added later, so wait)
  const hasX = !!handle(c), hasSite = isUrl(c.project_url);
  const linksOk = REQUIRE === "any" ? hasX || hasSite : hasX && hasSite;
  if (!linksOk) return { status: "wait", c };

  // ETH only: reject if the floor is priced in anything other than ETH/WETH (e.g. USDG)
  try {
    const st = await os(`/collections/${c.collection}/stats`);
    const sym = st.total?.floor_price_symbol;
    if (sym && !/^w?eth$/i.test(sym)) return { status: "drop", c };
  } catch (e) { console.error(e.message); }
  return { status: "pass", c };
}

async function alertProject(c) {
  found++;
  const contract = c.contracts?.[0]?.address;
  const desc = (c.description || "").replace(/\s+/g, " ");
  await tg(
    `🆕 <b>New NFT project on Robinhood Chain</b>\n` +
    `<b>${esc(c.name || c.collection)}</b>\n` +
    (desc ? `${esc(desc.slice(0, 160))}${desc.length > 160 ? "…" : ""}\n` : "") +
    (contract ? `Contract: <code>${esc(contract)}</code>\n` : "") +
    (handle(c) ? `X: https://x.com/${esc(handle(c))}\n` : "") +
    (isUrl(c.project_url) ? `Website: ${esc(c.project_url)}\n` : "") +
    `<a href="${esc(c.opensea_url || `https://opensea.io/collection/${c.collection}`)}">View on OpenSea</a>\n` +
    `⚠️ Verify the project before buying. New collections can be scams.`
  );
}

async function poll(chain) {
  const list = await fetchNewest(chain, 50);
  checks++;
  for (const c of list) {
    if (c.collection && !seen.has(c.collection)) {
      seen.add(c.collection);
      pending.set(c.collection, { c, first: Date.now(), last: 0 });
    }
  }
  while (pending.size > 150) pending.delete(pending.keys().next().value); // cap

  for (const [slug, p] of [...pending]) {
    if (Date.now() - p.first > PENDING_MS) { pending.delete(slug); continue; }
    if (p.last && Date.now() - p.last < RECHECK_MS) continue;
    p.last = Date.now();
    const r = await evaluate(p.c);
    if (r.status === "wait") { p.c = r.c; continue; }
    pending.delete(slug);
    if (r.status === "pass") await alertProject(r.c);
  }
}

(async function main() {
  const chain = await resolveChain();
  // Baseline: everything that already exists is marked seen, no alerts
  (await fetchNewest(chain, 100)).forEach(c => seen.add(c.collection));
  console.log(`Chain "${chain}" | baseline ${seen.size} collections | polling every ${POLL_MS / 60000} min`);
  await tg(`✅ New-project alert bot started for Robinhood Chain (baseline: ${seen.size} existing collections)`);

  setInterval(() => {
    tg(`💓 Bot alive. Last ${HEARTBEAT_MS / 3600000}h: ${found} projects passed the filters, ${pending.size} waiting for links, ${checks} checks run.`);
    found = 0; checks = 0;
  }, HEARTBEAT_MS);

  while (true) {
    await sleep(POLL_MS);
    try {
      await poll(chain);
      if (failAlerted) { failAlerted = false; await tg("✅ OpenSea checks working again"); }
      failures = 0;
    } catch (e) {
      failures++;
      console.error(e.message);
      if (failures >= 3 && !failAlerted) {
        failAlerted = true;
        await tg(`⚠️ Bot can't reach OpenSea (${failures} failed checks in a row). Check Railway logs.`);
      }
    }
  }
})().catch(async e => {
  console.error(e.message);
  await tg(`❌ Bot failed to start: ${esc(e.message)}`);
  process.exit(1);
});
