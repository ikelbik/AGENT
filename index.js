import 'dotenv/config'
import { createBot } from './bot/telegram.js'

async function main() {
  console.log('Starting AgentNet...')

  const bot = createBot()

  // Graceful shutdown
  process.once('SIGINT', () => bot.stop())
  process.once('SIGTERM', () => bot.stop())

  await bot.start({
    onStart: (info) => {
      console.log(`Bot @${info.username} started`)
      console.log('AgentNet is running')
    }
  })
}

main().catch(console.error)
