# mt-digest

Daily Slack digest that reconciles MarketTime orders against Shopify draft orders, posted to `#mt-order-transfer` every weekday at 5 PM EST.

## What it does

1. Fetches all orders from the MarketTime API (paginated)
2. Filters to orders whose `orderDate` falls within the lookback window (default: today)
3. For each order, checks Shopify for a matching draft order using:
   - **Primary:** tag `mt_recordID:{recordID}` — written by the MT import script
   - **Fallback:** metafield `mktt.recordid = {recordID}`
4. Posts a table to Slack showing every order and whether it transferred (Y/N)
5. Exits with a non-zero code if any orders are missing — making the GitHub Actions run go 🔴

### Example Slack message

```
✅ MT→Shopify Daily Digest — Monday, Jun 3

All 4 order(s) transferred to Shopify successfully.

─────────────────────────────────────────────────────
#   │ MT PO          │ Company                   │ MT Status  │ ✓
─────────────────────────────────────────────────────
1   │ PO-10045       │ Acme Gifts                │ OPEN       │ Y
2   │ PO-10046       │ Blue Ridge Hallmark        │ RECEIVED   │ Y
3   │ PO-10047       │ Sunshine Cards             │ OPEN       │ Y
4   │ PO-10048       │ Cornerstone Books          │ OPEN       │ Y
```

If any orders are missing, the header turns 🚨 and a separate alert block lists each missing order with its recordID for investigation.

---

## Repo structure

```
mt-digest/
├── digest.js          # Main script
├── package.json       # Dependencies (node-fetch, @slack/webhook)
├── package-lock.json  # Generated on first npm install
└── README.md

.github/
└── workflows/
    └── mt-daily-digest.yml   # Scheduled GitHub Actions workflow
```

---

## Setup

### 1. Create the Slack webhook

1. Go to your Slack workspace → **Apps** → search **Incoming Webhooks** → Add to Slack
2. Choose channel `#mt-order-transfer` (create it first if needed)
3. Copy the webhook URL — it looks like `https://hooks.slack.com/services/T.../B.../xxx`

### 2. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `MT_API_KEY` | Your MarketTime `x-api-key` header value |
| `MT_WHOAMI` | Your MT rep group segment — e.g. `M743553` |
| `SHOPIFY_STORE` | `your-store.myshopify.com` |
| `SHOPIFY_TOKEN` | Shopify Admin API access token |
| `SLACK_WEBHOOK_URL` | The webhook URL from step 1 |

### 3. Add files to your repo

```
your-repo/
├── scripts/
│   └── mt-digest/
│       ├── digest.js
│       ├── package.json
│       └── README.md
└── .github/
    └── workflows/
        └── mt-daily-digest.yml
```

Commit and push. The workflow will run automatically on the next scheduled trigger.

### 4. Run manually to catch the September gap

Go to **Actions → MT → Shopify Daily Digest → Run workflow** and set `lookback_days` to `90` (or however far back you want to check). This will surface any orders that were flipped to Received in MT but never landed in Shopify.

---

## Schedule

Runs weekdays at **22:00 UTC = 5:00 PM EST**. 

> ⚠️ During EDT (Mar–Nov), 5 PM Eastern is 21:00 UTC. Either adjust the cron to `0 21 * * 1-5` in summer, or just accept it fires at 6 PM EDT — up to you.

To run on weekends too, change `1-5` to `*` in the workflow cron.

---

## Running locally

```bash
cd scripts/mt-digest
npm install

MT_API_KEY=xxx \
MT_WHOAMI=M743553 \
SHOPIFY_STORE=your-store.myshopify.com \
SHOPIFY_TOKEN=xxx \
SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
LOOKBACK_DAYS=7 \
node digest.js
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MT_API_KEY` | ✅ | — | MarketTime API key |
| `MT_WHOAMI` | ✅ | — | MT rep group ID (e.g. `M743553`) |
| `SHOPIFY_STORE` | ✅ | — | Shopify store domain |
| `SHOPIFY_TOKEN` | ✅ | — | Shopify Admin API token |
| `SLACK_WEBHOOK_URL` | ✅ | — | Slack incoming webhook URL |
| `LOOKBACK_DAYS` | ❌ | `1` | How many days back to scan |

---

## How the Shopify match works

Your MT import script (`import-mt-orders.py`) tags every draft order it creates with `mt_recordID:{recordID}`. This digest queries Shopify for a draft order with that exact tag.

If no tag match is found, it falls back to checking the `mktt.recordid` metafield — covering any orders that came through a different path.

If neither matches, the order is marked **N** in the table and listed in the alert block at the bottom of the Slack message.

---

## Alerts

- The Actions run turns **red** if any orders are missing (non-zero exit code), so you'll see it in the repo without having to check Slack
- The Slack message subject line changes to 🚨 and lists each missing order with its PO number, company, and `recordID` so you can look it up directly
