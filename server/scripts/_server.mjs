// Допоміжне для скриптів замірів: підняти сервер окремим процесом і дочекатися /health.
import { spawn } from 'node:child_process'

export async function startServer(port, env = {}) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    base,
    child,
    // SIGTERM → чекаємо 'exit' і повертаємо код та час
    async stop() {
      const t0 = performance.now()
      const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
      child.kill('SIGTERM')
      return { ...(await exited), ms: Math.round(performance.now() - t0) }
    },
  }
}
