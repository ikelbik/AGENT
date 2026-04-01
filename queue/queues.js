import { Queue, Worker, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'
import 'dotenv/config'

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null
})

// ─── Queues ───────────────────────────────────────────────────────────────────

export const matchingQueue = new Queue('matching', { connection })
export const pingQueue     = new Queue('pings', { connection })
export const dialogueQueue = new Queue('dialogue', { connection })
export const notifyQueue   = new Queue('notify', { connection })

// ─── Job helpers ──────────────────────────────────────────────────────────────

export async function scheduleMatching(userId, delayMs = 0) {
  await matchingQueue.add('run-matching', { userId }, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  })
}

export async function scheduleDialogueTurn(dialogueId, senderId, message) {
  await dialogueQueue.add('process-turn', { dialogueId, senderId, message }, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 }
  })
}

export async function scheduleNotification(telegramId, message, extra = {}) {
  await notifyQueue.add('send-notification', { telegramId, message, extra }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 }
  })
}

export const schedulerQueue = new Queue('scheduler', { connection })

export async function startMatchingScheduler() {
  const intervalMs = process.env.MATCHING_INTERVAL_MS
    ? parseInt(process.env.MATCHING_INTERVAL_MS)
    : parseFloat(process.env.MATCHING_INTERVAL_HOURS || '24') * 60 * 60 * 1000

  // Remove all existing repeatable jobs so stale intervals don't persist across deploys
  const repeatables = await schedulerQueue.getRepeatableJobs()
  for (const job of repeatables) {
    await schedulerQueue.removeRepeatableByKey(job.key)
  }

  await schedulerQueue.add('match-all', {}, {
    repeat: { every: intervalMs },
    jobId: 'periodic-match-all'
  })
  console.log(`[scheduler] Matching scheduled every ${intervalMs / 1000}s`)
}

export { connection }
