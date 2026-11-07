import { resolve } from 'node:path'

// Конфіг лише з оточення (process.env), значення перевіряються ОДИН раз на старті:
// краще впасти зараз із зрозумілим повідомленням, ніж о 3-й ночі з undefined.

const SERVER_ROOT = resolve(import.meta.dirname, '..') // у ESM немає __dirname

export function loadConfig(env = process.env) {
  const errors = []
  const int = (name, fallback, min, max) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} має бути цілим у [${min}, ${max}], отримано "${raw}"`)
      return fallback
    }
    return n
  }
  const level = env.LOG_LEVEL ?? 'info'
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(level)) {
    errors.push(`LOG_LEVEL має бути debug|info|warn|error|silent, отримано "${level}"`)
  }

  const config = Object.freeze({
    port: int('PORT', 3000, 0, 65535), // 0 — випадковий вільний порт (тести)
    host: env.HOST || '0.0.0.0',
    logDir: resolve(SERVER_ROOT, env.LOG_DIR || 'logs'),
    clientDist: resolve(SERVER_ROOT, env.CLIENT_DIST || '../client/dist'),
    logLevel: level,
    maxRooms: int('MAX_ROOMS', 20, 1, 1000),
    maxPlayersPerRoom: int('MAX_PLAYERS_PER_ROOM', 4, 2, 64),
    joinTimeoutMs: int('JOIN_TIMEOUT_MS', 5000, 50, 60_000),
    heartbeatMs: int('HEARTBEAT_MS', 15_000, 50, 120_000),
    rateLimitPerSec: int('RATE_LIMIT_PER_SEC', 10, 1, 1000),
    rateLimitBurst: int('RATE_LIMIT_BURST', 20, 1, 1000),
    maxPayloadBytes: 4096,
    maxBodyBytes: 4096,
    softBufferBytes: 64 * 1024, // вище — не шлемо клієнту некритичне (чат)
    hardBufferBytes: 1024 * 1024, // вище — клієнт безнадійно відстав, розриваємо
    debugRoutes: env.NODE_ENV !== 'production', // /api/debug/* лише в розробці
  })
  if (errors.length) throw new Error(`Невалідний конфіг:\n  ${errors.join('\n  ')}`)
  return config
}
