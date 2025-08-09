# AI-Powered Travel Itinerary API (Cloudflare Worker)

A serverless API that accepts travel requests, generates a detailed itinerary via AI in the background, and stores results in Firestore.

**Live API Endpoint:** [https://itinerary-worker.mahyarmanzelatimr7.workers.dev](https://itinerary-worker.mahyarmanzelatimr7.workers.dev)

---

## Features

- **Instant response** with a `jobId` (HTTP 202) while processing continues asynchronously.
- **AI-powered** itinerary generation using OpenAI GPT (customizable).
- **Firestore persistence** with Zod schema validation.
- **Retry & error handling** for LLM calls.
- Fully **serverless** via Cloudflare Workers.

---

## Tech Stack

- **Cloudflare Workers** — Serverless API hosting
- **Google Cloud Firestore** — Real-time database
- **OpenAI GPT** — AI itinerary generation
- **Zod** — JSON schema validation

---

## Firestore Schema

```json
{
  "status": "completed" | "processing" | "failed",
  "destination": "Paris, France",
  "durationDays": 3,
  "createdAt": "Firestore Timestamp",
  "completedAt": "Firestore Timestamp or null",
  "itinerary": [
    {
      "day": 1,
      "theme": "Historical Paris",
      "activities": [
        {
          "time": "Morning",
          "description": "Visit the Louvre Museum. Pre-book tickets to avoid queues.",
          "location": "Louvre Museum"
        }
      ]
    }
  ],
  "error": "Error message if status is 'failed', otherwise null"
}
```

---

## Getting Started

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Clone the Repository

```bash
git clone https://github.com/MahyarManzelati/working.git
cd working
```

### 3. Set Environment Secrets

```bash
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put OPENAI_API_KEY
```

> **Note:** `FIREBASE_PRIVATE_KEY` must include real newlines, not `\n`.

### 4. Local Development

```bash
npm install
wrangler dev
```

### 5. Deploy

```bash
wrangler deploy
```

---

## API Usage

### Create an Itinerary

```bash
curl -X POST https://itinerary-worker.mahyarmanzelatimr7.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"destination": "Tokyo, Japan", "durationDays": 5}'
```

**Response:**

```json
{ "jobId": "d6f9c4b2-8a57-4a5f-9e01-b3f12f8d9f4a" }
```

### Check Itinerary Status

```bash
curl "https://itinerary-worker.mahyarmanzelatimr7.workers.dev?jobId=d6f9c4b2-8a57-4a5f-9e01-b3f12f8d9f4a"
```

---

## Firestore Security Rules Example

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /itineraries/{jobId} {
      allow read;
      allow write: if request.auth.token.email == "<your-service-account-email>";
    }
  }
}
```

---

## Environment Variables

| Variable                | Description                     |
| ----------------------- | ------------------------------- |
| `FIREBASE_CLIENT_EMAIL` | Firestore service account email |
| `FIREBASE_PRIVATE_KEY`  | Firestore private key           |
| `FIREBASE_PROJECT_ID`   | Google Cloud Project ID         |
| `OPENAI_API_KEY`        | API key for your LLM provider   |

---
