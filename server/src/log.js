// Мінімальний структурований лог: один JSON-рядок на подію в stdout (повноцінний pino — Lab 8).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
let threshold = LEVELS.info

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info
}

export function log(level, event, fields = {}) {
  if (LEVELS[level] < threshold) return
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })
  ;(level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
}
