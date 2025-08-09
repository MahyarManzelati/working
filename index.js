import { getAccessToken, createItineraryDoc } from './firestore.js';
import { processPendingJobs } from './jobs.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      const { destination, durationDays } = payload;
      if (typeof destination !== 'string' || typeof durationDays !== 'number') {
        return new Response('Bad Request', { status: 400 });
      }
      const jobId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await env.JOBS_KV.put(
        jobId,
        JSON.stringify({ destination, durationDays, status: 'pending', createdAt })
      );
      ctx.waitUntil(createItineraryDoc(env, jobId, { destination, durationDays, createdAt }));
      ctx.waitUntil(processPendingJobs(env));
      return new Response(JSON.stringify({ jobId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'GET') {
      const jobId = url.searchParams.get('jobId');
      if (!jobId) return new Response('Missing jobId', { status: 400 });
      try {
        const token = await getAccessToken(env);
        const docRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${env.FIRESTORE_PROJECT_ID}/databases/(default)/documents/itineraries/${jobId}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!docRes.ok) return new Response(`Fetch failed: ${docRes.status}`, { status: docRes.status });
        const doc = await docRes.json();
        const f = doc.fields;
        const output = {
          status:       f.status.stringValue,
          destination:  f.destination.stringValue,
          durationDays: parseInt(f.durationDays.integerValue, 10),
          createdAt:    f.createdAt.timestampValue,
          completedAt:  f.completedAt.timestampValue || null,
          itinerary:    f.itinerary.stringValue ? JSON.parse(f.itinerary.stringValue) : null,
          error:        f.error.stringValue || null
        };
        return new Response(JSON.stringify(output), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response('Method Not Allowed', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processPendingJobs(env));
  }
};