# Async LLM Itinerary — Cloudflare Worker + Firestore (Final)

A single Cloudflare Worker that accepts a travel request, returns a job ID immediately (HTTP 202), generates a structured itinerary with an LLM **asynchronously**, and persists status/results in **Google Firestore**.

---

## Features

- **Instant 202 + jobId** on `POST /`.
- **Background processing** using `ctx.waitUntil` + a KV-backed work queue; optional **Cron** sweeper for reliability.
- **LLM integration** (OpenAI) with retries, timeout, and **Zod** validation.
- **Firestore persistence** via Service Account (JWT → access token) using the REST API.
- **GET /?jobId=...** to check status (`processing|completed|failed`) and fetch the itinerary or error.

---

## Repo structure

```
async-itins/
├─ index.js          # Worker entry: routes + 202 response + waitUntil + GET status
├─ jobs.js           # Queue processor: LLM call, Zod validation, save results
├─ llm.js            # OpenAI call, retries/backoff, JSON extraction
├─ firestore.js      # OAuth2 JWT (WebCrypto) + Firestore REST helpers
├─ package.json
├─ package-lock.json
├─ wrangler.jsonc    # Worker config (bindings, KV, cron)
├─ .gitignore
└─ .env.example      # (only for frontend demos; not used by Worker)
```

---

## Prerequisites

- Node 18+
- Cloudflare account + **Wrangler** (`npm i -g wrangler`)
- Google Cloud project with **Firestore (Native mode)** enabled
- Service Account with role **Cloud Datastore User** (or Firestore User) and a **JSON key**
- OpenAI API key (or swap to your provider)

---

## 1) Configure Wrangler

Make sure `wrangler.jsonc` points to your entry and has KV + Cron:

```jsonc
{
  "name": "itinerary-worker",
  "main": "index.js",
  "compatibility_date": "2025-08-03",
  "vars": { "FIRESTORE_PROJECT_ID": "<your-gcp-project-id>" },
  "kv_namespaces": [
    {
      "binding": "JOBS_KV",
      "id": "<prod-namespace-id>",
      "preview_id": "<dev-preview-namespace-id>"
    }
  ],
  "triggers": { "crons": ["*/1 * * * *"] }
}
```

Create KV namespaces (one for prod, one for preview/dev):

```bash
wrangler kv namespace create JOBS_KV
wrangler kv namespace create JOBS_KV --preview
# paste the returned ids into wrangler.jsonc as id / preview_id
```

> Note: Miniflare (local dev) doesn’t auto-run cron. Remote dev or deploy uses the cron sweeper.

---

## 2) Set secrets (safe: not in git)

Use **Wrangler Secrets** so no `.env` is required for the Worker.

```bash
wrangler secret put SERVICE_ACCOUNT_EMAIL           # from service account JSON: client_email
wrangler secret put SERVICE_ACCOUNT_PRIVATE_KEY     # full PEM, include BEGIN/END lines
wrangler secret put LLM_API_KEY                     # OpenAI (or your LLM) key
```

If you kept `FIRESTORE_PROJECT_ID` under `vars` in `wrangler.jsonc`, **do not** also set it as a secret (names must be unique). If you prefer it secret, remove it from `vars` and then:

```bash
wrangler secret put FIRESTORE_PROJECT_ID
```

### Local-only convenience (optional)

For local dev without remote bindings, you can use a **.dev.vars** file (do not commit):

```
SERVICE_ACCOUNT_EMAIL=your-sa@your-project.iam.gserviceaccount.com
SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...full key...
-----END PRIVATE KEY-----"
LLM_API_KEY=sk-...
FIRESTORE_PROJECT_ID=your-gcp-project-id
```

Then run `wrangler dev` locally. For deploy/remote, keep using Wrangler Secrets.

---

## 3) Run (two ways)

### A) Local dev (uses .dev.vars)

```bash
wrangler dev
```

### B) Remote dev (loads cloud secrets + preview KV)

```bash
# ensure you set preview_id in wrangler.jsonc
wrangler dev --remote
```

---

## 4) Test the API

**Create a job (expect 202 + jobId):**

```bash
curl -i -X POST "http://127.0.0.1:8787/" \
  -H "Content-Type: application/json" \
  -d '{"destination":"Tokyo, Japan","durationDays":5}'
```

**Poll status by jobId:**

```bash
curl "http://127.0.0.1:8787/?jobId=<uuid>"
```

You’ll see `status: "processing"` first, then `"completed"` with the itinerary, or `"failed"` with an error.

---

## 5) Deploy

```bash
wrangler publish
```

You’ll get a `https://<name>.<subdomain>.workers.dev` URL. Use the same `POST`/`GET` calls with that base URL.

---

## 6) Firestore rules (recommended)

Lock down Firestore so only the Worker (service account) can read/write via REST:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /itineraries/{docId} {
      allow read, write: if false; // server-only
    }
  }
}
```

**Console:** Firestore → Rules → paste → Publish.

For a temporary public demo UI (read-only), you may allow reads:

```txt
match /itineraries/{docId} {
  allow read: if true;  // demo only, not production
  allow write: if false;
}
```

Revert to server-only afterward.

---

## API reference

### `POST /`

Request body:

```json
{ "destination": "Tokyo, Japan", "durationDays": 5 }
```

Response (202):

```json
{ "jobId": "<uuid>" }
```

### `GET /?jobId=<uuid>`

Response (200):

```json
{
  "status": "processing|completed|failed",
  "destination": "...",
  "durationDays": 5,
  "createdAt": "2025-08-09T10:20:00.000Z",
  "completedAt": "2025-08-09T10:20:45.000Z",
  "itinerary": [ { "day": 1, "theme": "...", "activities": [ ... ] } ] | null,
  "error": "..." | null
}
```

---

## Architecture (brief)

- **index.js** — Handles routes. `POST` enqueues job in KV and responds 202 immediately. `GET` reads Firestore via REST and returns the normalized document.
- **jobs.js** — Cron + on-demand processor: locks jobs, calls the LLM with timeout and retries, validates the JSON with Zod, saves results/failed status to Firestore, and cleans KV.
- **llm.js** — Calls OpenAI chat completions, retries on 429/5xx/network errors with exponential backoff + jitter, extracts a strict JSON array.
- **firestore.js** — Creates OAuth2 access token via a signed JWT using WebCrypto; `createItineraryDoc` writes the initial `processing` doc; `saveItinerary` updates to `completed`/`failed` and stores the itinerary and timestamps.

**Note:** The itinerary is stored as a JSON string for simplicity; the GET handler parses it back into an array. For a stricter schema-in-Firestore approach, encode it as Firestore array/map values.

---

## Troubleshooting

- **`SERVICE_ACCOUNT_EMAIL is not set` / `PRIVATE_KEY is not set`** → add secrets via `wrangler secret put ...` or use `.dev.vars` in local.
- **`Binding name already in use`** → don’t define the same name as both a `var` and a `secret`.
- **KV remote dev error** → create a preview namespace and add `preview_id` in `wrangler.jsonc`.
- **Cron not triggering locally** → use `wrangler dev --remote` or deploy; Miniflare doesn’t auto-run cron.
- **LLM rate limits** → built-in retries/backoff help; try again later if failures persist.
