// File: firestore.js

// Helper: convert PEM PKCS#8 string to ArrayBuffer
function pemToArrayBuffer(pem) {
  if (!pem) throw new Error('SERVICE_ACCOUNT_PRIVATE_KEY is not set');
  const normalized = pem.replace(/\\n/g, '').replace(/\r?\n/g, '');
  const stripped = normalized
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '');
  const b64 = stripped.replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function getAccessToken(env) {
  if (!env.SERVICE_ACCOUNT_EMAIL) throw new Error('SERVICE_ACCOUNT_EMAIL is not set');
  if (!env.SERVICE_ACCOUNT_PRIVATE_KEY) throw new Error('SERVICE_ACCOUNT_PRIVATE_KEY is not set');
  if (!env.FIRESTORE_PROJECT_ID) throw new Error('FIRESTORE_PROJECT_ID is not set');
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   env.SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now
  };
  const toBase64Url = obj =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const unsignedJWT = `${toBase64Url(header)}.${toBase64Url(claims)}`;

  const der = pemToArrayBuffer(env.SERVICE_ACCOUNT_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsignedJWT)
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${unsignedJWT}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
  const { access_token } = await resp.json();
  if (!access_token) throw new Error('No access_token in response');
  return access_token;
}

const BASE_URL = env =>
  `https://firestore.googleapis.com/v1/projects/${env.FIRESTORE_PROJECT_ID}` +
  `/databases/(default)/documents/itineraries`;

export async function createItineraryDoc(env, jobId, { destination, durationDays, createdAt }) {
  const token = await getAccessToken(env);
  const url = `${BASE_URL(env)}/${jobId}`;
  const body = {
    fields: {
      status:       { stringValue: 'processing' },
      destination:  { stringValue: destination },
      durationDays: { integerValue: String(durationDays) },
      createdAt:    { timestampValue: createdAt },
      completedAt:  { nullValue: null },
      itinerary:    { nullValue: null },
      error:        { nullValue: null }
    }
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`createItineraryDoc failed: ${res.status}`);
}

export async function saveItinerary(env, jobId, { status, itinerary, updatedAt, completedAt, error }) {
  const token = await getAccessToken(env);

  // Determine which fields to update
  const paths = ['status', 'updatedAt', 'completedAt', 'error'];
  if (itinerary !== undefined) paths.push('itinerary');
  const qs = paths.map(p => `updateMask.fieldPaths=${p}`).join('&');

  const url = `${BASE_URL(env)}/${jobId}?${qs}`;
  const fields = {
    status:      { stringValue: status },
    updatedAt:   { timestampValue: updatedAt },
    completedAt: completedAt
      ? { timestampValue: completedAt }
      : { nullValue: null },
    error:       error
      ? { stringValue: error }
      : { nullValue: null }
  };
  if (itinerary !== undefined) {
    fields.itinerary = { stringValue: JSON.stringify(itinerary) };
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`saveItinerary failed: ${res.status} ${text}`);
  }
}
