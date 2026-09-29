// All new OpenSea listings on Robinhood Chain -> Telegram
// Env: OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
// Optional: MAX_PRICE (e.g. 0.05, in the listing's currency), CHAIN_MATCH (default "robinhood")
import { OpenSeaStreamClient } from "@opensea/stream-js";
import WebSocket from "ws";

const { OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const MAX_PRICE = process.env.MAX_PRICE ? Number(process.env.MAX_PRICE) : null;
const CHAIN_RE = new RegExp(process.env.CHAIN_MATCH || "robinhood", "i");

if (!OPENSEA_API_KEY || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Set OPENSEA_API_KEY, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID");
  process.exit(1);
}

const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Telegram allows ~1 msg/sec to one chat, so queue messages
const queue = [];
let sending = false;
async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const text = queue.shift();
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      });
      if (res.status === 429) {
        const wait = (await res.json()).parameters?.retry_after ?? 5;
        queue.unshift(text);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) console.error("Telegram", res.status, await res.text());
    } catch (e) { console.error("Telegram", e.message); }
    await sleep(1100);
    if (queue.length > 200) queue.splice(0, queue.length - 100); // drop backlog if flooded
  }
  sending = false;
}
const notify = t => { queue.push(t); pump(); };

const seen = new Set();
const client = new OpenSeaStreamClient({
  token: OPENSEA_API_KEY,
  connectOptions: { transport: WebSocket },
});

client.onItemListed("*", ev => {
  const p = ev.payload || {};
  const item = p.item || {};
  const nftId = item.nft_id || "";                // "chain/contract/tokenId"
  const chain = item.chain?.name || nftId.split("/")[0] || "";
  if (!CHAIN_RE.test(chain)) return;              // Robinhood Chain only

  const id = p.order_hash || `${nftId}-${ev.sent_at}`;
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 5000) [...seen].slice(0, 2500).forEach(x => seen.delete(x));

  const dec = p.payment_token?.decimals ?? 18;
  const sym = p.payment_token?.symbol ?? "";
  const price = p.base_price != null ? Number(p.base_price) / 10 ** dec : null;
  if (MAX_PRICE != null && (price == null || price > MAX_PRICE)) return;

  const name = item.metadata?.name || nftId.split("/").pop() || "Unknown";
  const link = item.permalink || "https://opensea.io";
  notify(
    `🆕 <b>New listing (Robinhood Chain)</b>\n` +
    `${esc(name)}\n` +
    `Price: <b>${price == null ? "n/a" : price.toFixed(5).replace(/\.?0+$/, "")} ${esc(sym)}</b>\n` +
    `<a href="${esc(link)}">View on OpenSea</a>`
  );
});

client.connect();
notify("✅ Robinhood Chain listing bot started");
console.log("Listening for listings...");
