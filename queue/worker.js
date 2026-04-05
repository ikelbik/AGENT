import { Worker } from 'bullmq'
import { connection, scheduleMatching, startMatchingScheduler } from './queues.js'
import { runMatching } from '../agent/matching.js'
import { db } from '../db/postgres.js'
import 'dotenv/config'

// ─── Matching worker ──────────────────────────────────────────────────────────

new Worker('matching', async (job) => {
  const { agentId } = job.data
  console.log(`[matching] Running for agent ${agentId}`)

  let results
  try {
    results = await runMatching(agentId)
  } catch (e) {
    console.error(`[matching] CRASH for ${agentId}:`, e.message, e.stack?.split('\n')[1])
    return
  }

  if (results.error) {
    console.warn(`[matching] Error: ${results.error}`)
    return
  }

  console.log(`[matching] Done for ${agentId}: ${results.matches.length} matches`)
}, { connection })

// ─── Scheduler worker ─────────────────────────────────────────────────────────

new Worker('scheduler', async (job) => {
  if (job.name !== 'match-all') return
  const agents = await db.getActiveMatchingAgents()
  console.log(`[scheduler] Running matching for ${agents.length} active agents`)
  for (const agent of agents) {
    await scheduleMatching(agent.id)
  }
}, { connection })

// Start periodic scheduler on worker boot
startMatchingScheduler()

console.log('Workers started')
