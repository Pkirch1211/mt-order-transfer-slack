/**
 * LifeLines — Daily MT → Shopify Transfer Digest
 *
 * Fetches all MT orders via POST /orders/get (paginated, mirrors Python script exactly).
 * Filters to orders whose orderDate falls within the lookback window.
 * For each order, checks Shopify for a matching draft order via:
 *   1. Tag:       mt_recordID:{recordID}          (primary — written by your import script)
 *   2. Metafield: mktt.recordid = {recordID}      (fallback)
 * Posts a table to Slack channel #mt-order-transfer at 5 PM EST.
 *
 * Required env vars / GitHub Secrets:
 *   MT_API_KEY        — x-api-key header value for MarketTime
 *   MT_WHOAMI         — rep group segment, e.g. M743553
 *   SHOPIFY_STORE     — your-store.myshopify.com
 *   SHOPIFY_TOKEN     — Shopify Admin API token
 *   SLACK_WEBHOOK_URL — Incoming webhook URL for #mt-order-transfer
 *   LOOKBACK_DAYS     — optional, defaults to 1
 */

import fetch from "node-fetch";
import { IncomingWebhook } from "@slack/webhook";

// ── Config ────────────────────────────────────────────────────────────────────
const MT_API_KEY        = process.env.MT_API_KEY;
const MT_WHOAMI         = process.env.MT_WHOAMI;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN     = process.env.SHOPIFY_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const LOOKBACK_DAYS     = parseInt(process.env.LOOKBACK_DAYS || "1", 10);
const MT_BATCH          = 50;   // mirrors SERVER_LIMIT in Python
const SHOPIFY_API       = "2024-10";

for (const [k, v] of Object.entries({ MT_API_KEY, MT_WHOAMI, SHOPIFY_STORE, SHOPIFY_TOKEN, SLACK_WEBHOOK_URL })) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const MT_BASE      = `https://publicapi.markettime.com/mtpublic/api/v1/${MT_WHOAMI}`;
const SHOPIFY_BASE = `https://${SHOPIFY_STORE.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, attempt = 1) {
  const RETRY_MAX = 3;
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} — ${url}\n${body.slice(0, 300)}`);
    }
    return res;
  } catch (err) {
    if (attempt < RETRY_MAX) {
      console.warn(`[Retry ${attempt}] ${err.message}`);
      await sleep(1000 * attempt);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

// ── 1. Fetch all MT orders ────────────────────────────────────────────────────
// Mirrors Python exactly: POST /orders/get?offset=N&limit=50, body=[]
// Response: { response: [...orders], total: N }
// Order fields used: recordID, poNumber, billToName, manufacturerOrderStatus, orderDate
async function fetchAllMTOrders() {
  const url     = `${MT_BASE}/orders/get`;
  const headers = {
    "x-api-key":    MT_API_KEY,
    "Content-Type": "application/json",
    "Accept":       "application/json",
  };

  let offset        = 0;
  let totalReported = null;
  const seen        = new Set();
  const all         = [];

  while (true) {
    const res = await fetchWithRetry(
      `${url}?offset=${offset}&limit=${MT_BATCH}`,
      { method: "POST", headers, body: JSON.stringify([]) }
    );
    const payload = await res.json();
    const batch   = payload?.response ?? [];

    if (totalReported === null && payload?.total != null) {
      totalReported = parseInt(payload.total, 10);
    }

    if (!batch.length) {
      console.log(`[MT] offset=${offset} → 0 records, stopping.`);
      break;
    }

    let added = 0;
    for (const o of batch) {
      // Deduplication key mirrors Python: recordID or composite fallback
      const key = o.recordID ?? `${o.poNumber}|${o.retailerID}|${o.orderDate}`;
      if (!seen.has(String(key))) {
        seen.add(String(key));
        all.push(o);
        added++;
      }
    }

    console.log(`[MT] offset=${offset} → fetched=${batch.length} new=${added} total_so_far=${all.length} (api_total=${totalReported})`);
    offset += MT_BATCH;

    if (totalReported !== null && all.length >= totalReported) {
      console.log(`[MT] Reached api total=${totalReported}, stopping.`);
      break;
    }
    await sleep(50);
  }

  return all;
}

// ── 2. Shopify draft order lookup ─────────────────────────────────────────────
// Primary:  GraphQL tag query  tag:"mt_recordID:{id}"
// Fallback: GraphQL metafield  namespace=mktt key=recordid value={id}
// Returns draft order name string (e.g. "#D1001") if found, null if not.

const shopifyHeaders = {
  "X-Shopify-Access-Token": SHOPIFY_TOKEN,
  "Content-Type":           "application/json",
};

async function shopifyGQL(query, variables = {}) {
  const res = await fetchWithRetry(
    `${SHOPIFY_BASE}/admin/api/${SHOPIFY_API}/graphql.json`,
    { method: "POST", headers: shopifyHeaders, body: JSON.stringify({ query, variables }) }
  );
  const json = await res.json();
  if (json.errors?.length) {
    console.warn("[Shopify GQL errors]", JSON.stringify(json.errors));
  }
  return json;
}

// Per-run cache: recordID string → draft name string | null
const _draftCache = new Map();

async function findDraftByRecordID(recordID) {
  const id = String(recordID);
  if (_draftCache.has(id)) return _draftCache.get(id);

  // ── Strategy 1: tag search (exact match on mt_recordID:{id}) ──────────────
  // This is what your import script writes, so it will match the vast majority.
  try {
    const data = await shopifyGQL(
      `query($q: String!) {
        draftOrders(first: 5, query: $q) {
          edges { node { name tags } }
        }
      }`,
      { q: `tag:"mt_recordID:${id}"` }
    );
    for (const { node } of data?.data?.draftOrders?.edges ?? []) {
      // tags is a string[] in the Admin API
      const tags = Array.isArray(node.tags)
        ? node.tags
        : String(node.tags ?? "").split(",").map(t => t.trim());
      if (tags.includes(`mt_recordID:${id}`)) {
        _draftCache.set(id, node.name);
        return node.name;
      }
    }
  } catch (err) {
    console.warn(`[Shopify] Tag search failed for recordID ${id}: ${err.message}`);
  }

  // ── Strategy 2: metafield fallback (mktt.recordid) ────────────────────────
  // Shopify GraphQL doesn't allow filtering draftOrders by metafield value,
  // so we search recent "markettime"-tagged drafts and inspect metafields.
  // This catches any order created via a path that writes the metafield instead of the tag.
  try {
    const data = await shopifyGQL(
      `query($q: String!) {
        draftOrders(first: 50, query: $q) {
          edges {
            node {
              name
              metafields(first: 20, namespace: "mktt") {
                nodes { key value }
              }
            }
          }
        }
      }`,
      { q: `tag:markettime` }
    );
    for (const { node } of data?.data?.draftOrders?.edges ?? []) {
      const mfMatch = (node.metafields?.nodes ?? []).find(
        m => m.key === "recordid" && String(m.value) === id
      );
      if (mfMatch) {
        _draftCache.set(id, node.name);
        return node.name;
      }
    }
  } catch (err) {
    console.warn(`[Shopify] Metafield fallback failed for recordID ${id}: ${err.message}`);
  }

  _draftCache.set(id, null);
  return null;
}

// ── 3. Build digest rows ──────────────────────────────────────────────────────
function cutoffDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function buildRows(allMTOrders) {
  const cutoff = cutoffDate(LOOKBACK_DAYS);

  // Filter to orders in the lookback window by orderDate
  const inWindow = allMTOrders.filter(o => {
    if (!o.orderDate) return false;
    try { return new Date(o.orderDate) >= cutoff; } catch { return false; }
  });

  console.log(`[Digest] ${inWindow.length} MT orders in window (last ${LOOKBACK_DAYS} day(s), since ${cutoff.toISOString().slice(0,10)})`);

  const rows = [];
  for (let i = 0; i < inWindow.length; i++) {
    const o          = inWindow[i];
    const recordID   = o.recordID;
    const draftName  = recordID ? await findDraftByRecordID(String(recordID)) : null;

    rows.push({
      seq:         i + 1,
      mtPO:        String(o.poNumber    ?? "—"),
      company:     String(o.billToName  ?? "—"),
      mtStatus:    String(o.manufacturerOrderStatus ?? "—"),
      transferred: draftName !== null,
      draftName,
      recordID:    String(recordID ?? "—"),
    });

    // Light throttle every 10 Shopify calls
    if (i > 0 && i % 10 === 0) await sleep(250);
  }

  return rows;
}

// ── 4. Format Slack message ───────────────────────────────────────────────────
function buildSlackMessage(rows) {
  const now = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
    timeZone: "America/New_York",
  });

  const total       = rows.length;
  const okCount     = rows.filter(r => r.transferred).length;
  const missingRows = rows.filter(r => !r.transferred);
  const allGood     = missingRows.length === 0;

  // ── No orders in window ───────────────────────────────────────────────────
  if (total === 0) {
    return {
      text: `✅ MT→Shopify Digest — ${now}: No orders in window.`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `✅ MT→Shopify Daily Digest — ${now}`, emoji: true },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `No MarketTime orders found in the last ${LOOKBACK_DAYS} day(s).` },
        },
      ],
    };
  }

  // ── Fixed-width table in a code block ────────────────────────────────────
  // Columns match the screenshot exactly: # | MT PO | Company | MT Status | Y/N
  const W = { seq: 3, po: 14, company: 26, status: 10, yn: 3 };

  const pad = (s, w) => String(s ?? "").slice(0, w).padEnd(w);
  const trunc = (s, w) => {
    const str = String(s ?? "");
    return str.length > w ? str.slice(0, w - 1) + "…" : str.padEnd(w);
  };

  const divider = "─".repeat(W.seq + W.po + W.company + W.status + W.yn + 4 * 3);

  const headerRow = [
    pad("#",         W.seq),
    pad("MT PO",     W.po),
    pad("Company",   W.company),
    pad("MT Status", W.status),
    pad("✓",         W.yn),
  ].join(" │ ");

  const dataRows = rows.map(r => [
    pad(r.seq,      W.seq),
    trunc(r.mtPO,    W.po),
    trunc(r.company, W.company),
    trunc(r.mtStatus, W.status),
    pad(r.transferred ? "Y" : "N", W.yn),
  ].join(" │ "));

  const table = ["```", headerRow, divider, ...dataRows, "```"].join("\n");

  // ── Summary line ──────────────────────────────────────────────────────────
  const summaryEmoji = allGood ? "✅" : "🚨";
  const summaryText  = allGood
    ? `All *${total}* order(s) transferred to Shopify successfully.`
    : `*${missingRows.length}* of ${total} order(s) not found in Shopify — action required.`;

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${summaryEmoji} MT→Shopify Daily Digest — ${now}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summaryText },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: table },
    },
  ];

  // ── Alert block for missing orders ────────────────────────────────────────
  if (missingRows.length > 0) {
    const lines = missingRows.map(r =>
      `• PO \`${r.mtPO}\` — ${r.company}  _(recordID: ${r.recordID})_`
    );
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⚠️ Orders not found in Shopify — investigate:*\n${lines.join("\n")}`,
      },
    });
  }

  return {
    text: `${summaryEmoji} MT→Shopify Digest — ${now} | ${okCount}/${total} transferred`,
    blocks,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[Digest] Starting. LOOKBACK_DAYS=${LOOKBACK_DAYS}, store=${SHOPIFY_STORE}`);

  const allOrders = await fetchAllMTOrders();
  const rows      = await buildRows(allOrders);
  const message   = buildSlackMessage(rows);

  const missing = rows.filter(r => !r.transferred).length;
  console.log(`[Digest] Rows: ${rows.length} total, ${rows.length - missing} transferred, ${missing} missing`);

  const webhook = new IncomingWebhook(SLACK_WEBHOOK_URL);
  await webhook.send(message);
  console.log("[Digest] ✅ Slack message sent.");

  if (missing > 0) {
    console.error(`[Digest] ❌ ${missing} order(s) not found in Shopify.`);
    process.exit(1);  // Makes the Actions run go red for missing orders
  }
}

main().catch(err => {
  console.error("[Digest] Fatal:", err);
  process.exit(1);
});
