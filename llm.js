// llm.js

/**
 * Tiny sleep
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper with exponential backoff + jitter.
 * Retries on 429 and 5xx, and on network errors.
 */
async function fetchWithRetry(url, options, {
  retries = 3,
  baseDelay = 500, // ms
  factor = 2,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        // bubble the failure with context
        throw new Error(`LLM request failed: HTTP ${res.status}`);
      }
    } catch (err) {
      // Network errors are retryable unless we ran out or the request was aborted
      if (err?.name === 'AbortError') throw new Error('LLM request aborted by timeout');
      if (attempt >= retries) throw err;
    }

    // backoff with jitter
    const delay = baseDelay * Math.pow(factor, attempt);
    const jitter = Math.floor(Math.random() * baseDelay);
    await sleep(delay + jitter);
    attempt++;
  }
}

/**
 * Extracts the first JSON array from a string by bracket matching.
 */
function extractFirstJsonArray(str) {
  const start = str.indexOf('[');
  if (start === -1) throw new Error('No JSON array start found');
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '[') depth++;
    else if (str[i] === ']') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  throw new Error('No matching ] found for JSON array');
}

/**
 * Calls the OpenAI API to generate a structured travel itinerary.
 *
 * @param {string} destination
 * @param {number} durationDays
 * @param {string} apiKey
 * @param {{ signal?: AbortSignal, retries?: number, baseDelay?: number }} opts
 * @returns {Promise<Array>}
 */
export async function generateItinerary(destination, durationDays, apiKey, opts = {}) {
  const { signal, retries = 3, baseDelay = 500 } = opts;

  const messages = [
    { role: 'system', content: 'Output exactly one JSON array—no commentary, no markdown.' },
    {
      role: 'user',
      content:
        `Itinerary for ${durationDays} days in ${destination}. ` +
        'Return exactly a JSON array:\n' +
        `[{"day":number,"theme":string,"activities":[{"time":string,"description":string,"location":string}]}...]`
    }
  ];

  const body = JSON.stringify({
    model: 'gpt-4o',
    messages,
    temperature: 0.2,
    max_tokens: 1500
  });

  const resp = await fetchWithRetry(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body,
      signal, // <— enables timeout/abort from caller
    },
    { retries, baseDelay }
  );

  const { choices } = await resp.json();
  const raw = choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty LLM response');

  // Try direct parse; fall back to extracting the first array
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const arrText = extractFirstJsonArray(trimmed);
    return JSON.parse(arrText);
  }
}

/**
 * (Deprecated) Old withTimeout did nothing. Keep a no-op export to avoid import breaks.
 * Prefer handling timeouts at the call site with AbortController (see jobs.js).
 */
export function withTimeout(promise) {
  return promise;
}
