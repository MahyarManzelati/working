// jobs.js

import { z } from 'zod';
import { generateItinerary } from './llm.js';
import { saveItinerary } from './firestore.js';

// ----- Zod schema -----
const Activity = z.object({
  time:        z.string(),
  description: z.string(),
  location:    z.string(),
});
const DayItinerary = z.object({
  day:        z.number().int().min(1),
  theme:      z.string(),
  activities: z.array(Activity).min(1),
});
const ItinerarySchema = z.array(DayItinerary).min(1);

// Helper: run an async function with an aborting timeout
async function runWithTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function processPendingJobs(env) {
  const { keys } = await env.JOBS_KV.list();
  const now = Date.now();

  for (const { name: jobId } of keys) {
    const raw = await env.JOBS_KV.get(jobId);
    if (!raw) continue;
    const job = JSON.parse(raw);

    // reset stale in-progress jobs
    if (job.status === 'in-progress' && now - new Date(job.lockedAt).getTime() > 600_000) {
      job.status = 'pending';
      delete job.error;
      await env.JOBS_KV.put(jobId, JSON.stringify(job));
    }
    if (job.status !== 'pending') continue;

    // lock
    job.status   = 'in-progress';
    job.lockedAt = new Date().toISOString();
    await env.JOBS_KV.put(jobId, JSON.stringify(job));

    try {
      // 1) Generate via LLM with retry + timeout (30s)
      const rawItinerary = await runWithTimeout(
        (signal) =>
          generateItinerary(
            job.destination,
            job.durationDays,
            env.LLM_API_KEY,
            { signal, retries: 3, baseDelay: 500 }
          ),
        30_000
      );

      // 2) Validate against Zod schema
      const itinerary = ItinerarySchema.parse(rawItinerary);

      // 3) Persist success
      const nowTs = new Date().toISOString();
      await saveItinerary(env, jobId, {
        status:      'completed',
        itinerary,
        updatedAt:   nowTs,
        completedAt: nowTs,
        error:       null,
      });

      // 4) cleanup KV
      await env.JOBS_KV.delete(jobId);

    } catch (err) {
      // Normalize a clear error message for Firestore
      const nowTs = new Date().toISOString();
      let message =
        err instanceof z.ZodError
          ? 'Validation error: ' + err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')
          : (err?.message || 'Unknown error');

      // Mark Firestore doc as failed (meets the challenge requirement)
      try {
        await saveItinerary(env, jobId, {
          status:      'failed',
          updatedAt:   nowTs,
          completedAt: null,
          error:       message,
        });
      } catch (persistErr) {
        // If persistence fails, record in KV so you can inspect later
        message += ` | persistError: ${persistErr?.message || persistErr}`;
      }

      // Record failure in KV to prevent reprocessing without operator action
      job.status = 'failed';
      job.error  = message;
      await env.JOBS_KV.put(jobId, JSON.stringify(job));
    }
  }
}
