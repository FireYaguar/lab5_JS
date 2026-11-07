import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { log } from './log.js'

let config
try {
  config = loadConfig(process.env)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const app = createApp(config)
await app.listen()

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'server.shutdown', { signal })
  // якщо щось зависло — не чекаємо вічно (supervisor однаково вб’є через ~10 с)
  setTimeout(() => {
    log('error', 'server.shutdown.timeout')
    process.exit(1)
  }, 8000).unref()
  await app.shutdown()
  log('info', 'server.stopped', { code: 0 })
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
