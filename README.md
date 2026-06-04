# mt-digest

Daily email digest that reconciles MarketTime orders against Shopify draft orders, sent every weekday at 5 PM EST.

## What it does

1. Fetches all orders from the MarketTime API (paginated POST, mirrors the Python import script)
2. Filters to orders whose `orderDate` falls within the lookback window (default: today)
3. For each order, checks Shopify for a matching draft order using:
   - **Primary:** tag `mt_recordID:{recordID}` — written by your MT import script
   - **Fallback:** metafield `mktt.recordid = {recordID}`
4. Sends an HTML email with a full table — every order, Y/N transfer status, Shopify draft #
5. Subject line goes 🚨 and lists missing orders if anything didn't transfer
6. Exits non-zero if any orders are missing → GitHub Actions run goes red

---

## Repo structure

```
your-repo/
├── scripts/
│   └── mt-digest/
│       ├── digest.js        ← main script
│       ├── package.json     ← dependencies
│       └── README.md
└── .github/
    └── workflows/
        └── mt-daily-digest.yml
```

---

## Setup

### 1. Create a Gmail App Password

You can't use your regular Gmail password — Google requires an App Password for SMTP access.

1. Go to **https://myaccount.google.com/security**
2. Make sure **2-Step Verification** is turned on (required)
3. Search for **App passwords** in the search bar at the top
4. Click **App passwords** → select app: **Mail** → select device: **Other** → type `mt-digest` → click **Generate**
5. Copy the 16-character password shown (you won't see it again)

### 2. Add GitHub Secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `MT_API_KEY` | Your MarketTime `x-api-key` header value |
| `MT_WHOAMI` | Your MT rep group segment — e.g. `M743553` |
| `SHOPIFY_STORE` | `your-store.myshopify.com` |
| `SHOPIFY_TOKEN` | Shopify Admin API access token |
| `GMAIL_USER` | Your Gmail address, e.g. `paul@gmail.com` |
| `GMAIL_APP_PASSWORD` | The 16-character app password from step 1 |
| `RECIPIENT_EMAIL` | Who receives the digest (can be same as `GMAIL_USER`) |

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

Commit and push. The workflow fires automatically on the next scheduled trigger.

### 4. Run manually to catch the September gap

Go to **Actions → MT → Shopify Daily Digest → Run workflow** and set `lookback_days` to `90`. This will surface any orders that were flipped to Received in MT but never landed in Shopify.

---

## Schedule

Runs weekdays at **22:00 UTC = 5:00 PM EST**.

> ⚠️ During EDT (roughly Mar–Nov), 5 PM Eastern is 21:00 UTC. Either update the cron to `0 21 * * 1-5` in summer or just accept it fires at 6 PM EDT.

---

## Running locally

```bash
cd scripts/mt-digest
npm install

MT_API_KEY=xxx \
MT_WHOAMI=M743553 \
SHOPIFY_STORE=your-store.myshopify.com \
SHOPIFY_TOKEN=xxx \
GMAIL_USER=you@gmail.com \
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
RECIPIENT_EMAIL=you@gmail.com \
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
| `GMAIL_USER` | ✅ | — | Gmail address (sender) |
| `GMAIL_APP_PASSWORD` | ✅ | — | Gmail App Password |
| `RECIPIENT_EMAIL` | ❌ | `GMAIL_USER` | Recipient address |
| `LOOKBACK_DAYS` | ❌ | `1` | How many days back to scan |
