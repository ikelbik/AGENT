import 'dotenv/config'
import { createBot }     from './bot/telegram.js'
import { startApiServer } from './server/api.js'

async function main() {
  console.log('Starting AgentNet...')

  startApiServer()

  const bot = createBot()

  process.once('SIGINT',  () => bot.stop())
  process.once('SIGTERM', () => bot.stop())

  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      console.log(`Bot @${info.username} started`)
    }
  })
}

main().catch(console.error)
