/**
 * LifeLines — Daily MT → Shopify Transfer Digest (Email)
 *
 * Fetches all MT orders via POST /orders/get (paginated, mirrors Python script exactly).
 * Filters to orders whose orderDate falls within the lookback window.
 * For each order, checks Shopify for a matching draft order via:
 *   1. Tag:       mt_recordID:{recordID}          (primary — written by your import script)
 *   2. Metafield: mktt.recordid = {recordID}      (fallback)
 * Sends an HTML summary email via Gmail at 5 PM EST.
 *
 * Required env vars / GitHub Secrets:
 *   MT_API_KEY          — x-api-key header value for MarketTime
 *   MT_WHOAMI           — rep group segment, e.g. M743553
 *   SHOPIFY_STORE       — your-store.myshopify.com
 *   SHOPIFY_TOKEN       — Shopify Admin API token
 *   GMAIL_USER          — Gmail address used to send (and receive)
 *   GMAIL_APP_PASSWORD  — Gmail App Password (not your login password)
 *   RECIPIENT_EMAIL     — optional, defaults to GMAIL_USER
 *   LOOKBACK_DAYS       — optional, defaults to 1
 */

import fetch from "node-fetch";
import nodemailer from "nodemailer";

// ── Config ────────────────────────────────────────────────────────────────────
const MT_API_KEY         = process.env.MT_API_KEY;
const MT_WHOAMI          = process.env.MT_WHOAMI;
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN      = process.env.SHOPIFY_TOKEN;
const GMAIL_USER         = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RECIPIENT_EMAIL    = process.env.RECIPIENT_EMAIL || GMAIL_USER;
const LOOKBACK_DAYS      = parseInt(process.env.LOOKBACK_DAYS || "1", 10);
const MT_BATCH           = 50;
const SHOPIFY_API        = "2024-10";

for (const [k, v] of Object.entries({ MT_API_KEY, MT_WHOAMI, SHOPIFY_STORE, SHOPIFY_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD })) {
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
  if (json.errors?.length) console.warn("[Shopify GQL errors]", JSON.stringify(json.errors));
  return json;
}

const _draftCache = new Map();

async function findDraftByRecordID(recordID) {
  const id = String(recordID);
  if (_draftCache.has(id)) return _draftCache.get(id);

  // Strategy 1: tag match — mt_recordID:{id}
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
      const tags = Array.isArray(node.tags)
        ? node.tags
        : String(node.tags ?? "").split(",").map(t => t.trim());
      if (tags.includes(`mt_recordID:${id}`)) {
        _draftCache.set(id, node.name);
        return node.name;
      }
    }
  } catch (err) {
    console.warn(`[Shopify] Tag search failed for ${id}: ${err.message}`);
  }

  // Strategy 2: metafield fallback — mktt.recordid
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
      const match = (node.metafields?.nodes ?? []).find(
        m => m.key === "recordid" && String(m.value) === id
      );
      if (match) {
        _draftCache.set(id, node.name);
        return node.name;
      }
    }
  } catch (err) {
    console.warn(`[Shopify] Metafield fallback failed for ${id}: ${err.message}`);
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
  const cutoff    = cutoffDate(LOOKBACK_DAYS);
  const inWindow  = allMTOrders.filter(o => {
    if (!o.orderDate) return false;
    try { return new Date(o.orderDate) >= cutoff; } catch { return false; }
  });

  console.log(`[Digest] ${inWindow.length} MT orders in window (last ${LOOKBACK_DAYS} day(s), since ${cutoff.toISOString().slice(0,10)})`);

  const rows = [];
  for (let i = 0; i < inWindow.length; i++) {
    const o         = inWindow[i];
    const recordID  = o.recordID;
    const draftName = recordID ? await findDraftByRecordID(String(recordID)) : null;

    rows.push({
      seq:         i + 1,
      mtPO:        String(o.poNumber   ?? "—"),
      company:     String(o.billToName ?? "—"),
      mtStatus:    String(o.manufacturerOrderStatus ?? "—"),
      transferred: draftName !== null,
      draftName,
      recordID:    String(recordID ?? "—"),
    });

    if (i > 0 && i % 10 === 0) await sleep(250);
  }

  return rows;
}

// ── 4. Build HTML email ───────────────────────────────────────────────────────
function buildEmail(rows) {
  const now = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });

  const total       = rows.length;
  const okCount     = rows.filter(r => r.transferred).length;
  const missingRows = rows.filter(r => !r.transferred);
  const allGood     = missingRows.length === 0;

  const subject = total === 0
    ? `✅ [LifeLines] MT→Shopify Digest — No orders today`
    : allGood
      ? `✅ [LifeLines] MT→Shopify Digest — All ${total} order(s) transferred`
      : `🚨 [LifeLines] MT→Shopify Digest — ${missingRows.length} MISSING order(s)`;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const s = {
    body:      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;max-width:700px;margin:0 auto;padding:32px 16px;",
    h2:        "margin:0 0 4px;font-size:20px;",
    sub:       "color:#64748b;margin:0 0 24px;font-size:14px;",
    banner_ok: "background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 18px;margin-bottom:24px;color:#166534;font-weight:600;",
    banner_er: "background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px 18px;margin-bottom:24px;",
    table:     "width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:14px;",
    th:        "padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;",
    td:        "padding:10px 14px;border-bottom:1px solid #f1f5f9;",
    td_ok:     "padding:10px 14px;border-bottom:1px solid #f1f5f9;color:#16a34a;font-weight:700;",
    td_miss:   "padding:10px 14px;border-bottom:1px solid #f1f5f9;color:#dc2626;font-weight:700;",
    footer:    "font-size:12px;color:#94a3b8;margin-top:16px;",
    alert_h:   "margin:0 0 10px;font-size:15px;color:#991b1b;",
    alert_box: "background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px 20px;margin-top:24px;",
    alert_li:  "margin:4px 0;font-size:14px;color:#7f1d1d;font-family:monospace;",
  };

  // ── Banner ───────────────────────────────────────────────────────────────────
  let banner = "";
  if (total === 0) {
    banner = `<div style="${s.banner_ok}">✅ No MarketTime orders found in the last ${LOOKBACK_DAYS} day(s).</div>`;
  } else if (allGood) {
    banner = `<div style="${s.banner_ok}">✅ All ${total} order(s) transferred to Shopify successfully.</div>`;
  } else {
    banner = `<div style="${s.banner_er}">
      <strong style="color:#991b1b;">🚨 ${missingRows.length} order(s) marked in MarketTime but NOT found in Shopify.</strong>
      <p style="margin:6px 0 0;color:#7f1d1d;font-size:14px;">These orders may have been missed by the transfer flow. Investigate immediately.</p>
    </div>`;
  }

  // ── Table rows ───────────────────────────────────────────────────────────────
  const tableRows = rows.map(r => `
    <tr style="background:${r.transferred ? "#fff" : "#fff5f5"}">
      <td style="${s.td}">${r.seq}</td>
      <td style="${s.td}">${r.mtPO}</td>
      <td style="${s.td}">${r.company}</td>
      <td style="${s.td}">${r.mtStatus}</td>
      <td style="${r.transferred ? s.td_ok : s.td_miss}">${r.transferred ? "Y" : "N"}</td>
      <td style="${s.td};color:#94a3b8;font-size:12px;">${r.draftName ?? "—"}</td>
    </tr>`).join("");

  const table = total === 0 ? "" : `
    <table style="${s.table}">
      <thead>
        <tr>
          <th style="${s.th}">#</th>
          <th style="${s.th}">MT PO</th>
          <th style="${s.th}">Company</th>
          <th style="${s.th}">MT Status</th>
          <th style="${s.th}">Transferred</th>
          <th style="${s.th}">Shopify Draft #</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <p style="${s.footer}">${okCount} of ${total} order(s) confirmed in Shopify</p>`;

  // ── Alert block for missing orders ────────────────────────────────────────
  const alertBlock = missingRows.length === 0 ? "" : `
    <div style="${s.alert_box}">
      <p style="${s.alert_h}">⚠️ Orders not found in Shopify — investigate:</p>
      <ul style="margin:0;padding-left:18px;">
        ${missingRows.map(r => `<li style="${s.alert_li}">PO ${r.mtPO} — ${r.company} (recordID: ${r.recordID})</li>`).join("")}
      </ul>
    </div>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="${s.body}">
  <h2 style="${s.h2}">LifeLines — MT→Shopify Daily Digest</h2>
  <p style="${s.sub}">${now}</p>
  ${banner}
  ${table}
  ${alertBlock}
</body></html>`;

  return { subject, html };
}

// ── 5. Send email ─────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from:    `"LifeLines Ops" <${GMAIL_USER}>`,
    to:      RECIPIENT_EMAIL,
    subject,
    html,
  });

  console.log(`[Digest] ✅ Email sent: "${subject}"`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[Digest] Starting. LOOKBACK_DAYS=${LOOKBACK_DAYS}, store=${SHOPIFY_STORE}`);

  const allOrders = await fetchAllMTOrders();
  const rows      = await buildRows(allOrders);
  const { subject, html } = buildEmail(rows);

  await sendEmail(subject, html);

  const missing = rows.filter(r => !r.transferred).length;
  if (missing > 0) {
    console.error(`[Digest] ❌ ${missing} order(s) not found in Shopify.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[Digest] Fatal:", err);
  process.exit(1);
});
