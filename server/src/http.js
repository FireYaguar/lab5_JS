import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { listReplays, replayPath } from './log/replay.js'
import { log } from './log.js'
import { RoomError } from './rooms.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.ndjson': 'application/x-ndjson',
}
const HASHED = /-[\w-]{8}\.(js|css)$/ // файли Vite з хешем у назві можна кешувати назавжди

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

// Тіло запиту — потік шматків. Збираємо, але не більше limit байт (інакше будь-хто заллє пам’ять).
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, `body larger than ${limit} bytes`)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid json')
  }
}

function validateNewRoom(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 32) throw new HttpError(400, 'name: 1–32 chars required')
  const a = body.arena ?? {}
  const num = (v, def, min, max) => {
    if (v === undefined) return def
    if (!Number.isInteger(v) || v < min || v > max)
      throw new HttpError(400, `arena: ${v} out of [${min}, ${max}]`)
    return v
  }
  return {
    name,
    maxPlayers: num(body.maxPlayers, undefined, 2, 64),
    arena: {
      width: num(a.width, 1600, 600, 4000),
      height: num(a.height, 900, 400, 3000),
      asteroids: num(a.asteroids, 6, 0, 40),
      seed: num(a.seed, Math.floor(Math.random() * 1e9), 0, 2 ** 31 - 1),
    },
  }
}

// Відхиляємо будь-який сегмент «..» ще ДО нормалізації URL, потім перевіряємо, що шлях усередині root.
function staticPath(root, rawUrl) {
  let pathname
  try {
    pathname = decodeURIComponent(rawUrl.split('?')[0])
  } catch {
    throw new HttpError(400, 'bad path encoding')
  }
  if (pathname.includes('\0') || pathname.split(/[\\/]/).includes('..')) {
    throw new HttpError(400, 'bad path')
  }
  const file = resolve(root, `.${pathname}`)
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(400, 'bad path')
  return file
}

async function serveStatic(req, res, root) {
  let file = staticPath(root, req.url)
  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) throw new HttpError(404, 'not found')
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  await pipeline(createReadStream(file), res) // стрімом: великий файл не лягає в пам’ять цілком
}

// Потік файлу в відповідь. Якщо клієнт повільний — res.write() поверне false, pipeline призупинить
// читання з диска до 'drain'. Це і є backpressure: пам’ять не росте.
async function streamReplay(res, file) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, 'replay not found')
  res.writeHead(200, { 'Content-Type': MIME['.ndjson'], 'Content-Length': info.size })
  await pipeline(createReadStream(file), res)
}

export function createHttpHandler({ config, rooms }) {
  const routes = async (req, res, url) => {
    const { pathname } = url
    const m = req.method

    if (pathname === '/health' && m === 'GET') {
      const mem = process.memoryUsage()
      return sendJson(res, 200, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        rooms: rooms.size,
        players: rooms.playerCount,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
      })
    }

    if (pathname === '/api/rooms') {
      if (m === 'GET') return sendJson(res, 200, { version: 1, rooms: rooms.list() })
      if (m === 'POST') {
        const room = rooms.create(validateNewRoom(await readJsonBody(req, config.maxBodyBytes)))
        return sendJson(res, 201, { room })
      }
      throw new HttpError(405, 'method not allowed')
    }

    if (pathname === '/api/stats' && m === 'GET') {
      const matches = rooms
        .list()
        .filter((r) => r.match)
        .map((r) => ({ room: r.id, ...r.match.stats() }))
      return sendJson(res, 200, { matches })
    }

    if (pathname === '/api/replays' && m === 'GET') {
      return sendJson(res, 200, { replays: await listReplays(config.logDir) })
    }
    const replay = pathname.match(/^\/api\/replays\/([^/]+)$/)
    if (replay && m === 'GET') {
      const file = replayPath(config.logDir, replay[1])
      if (!file) throw new HttpError(400, 'bad replay id')
      return streamReplay(res, file)
    }

    if (config.debugRoutes && pathname.startsWith('/api/debug/')) {
      // Навмисні антипатерни для README (вимкнено при NODE_ENV=production)
      if (pathname === '/api/debug/block') {
        const ms = Math.min(Number(url.searchParams.get('ms')) || 300, 5000)
        const end = performance.now() + ms
        while (performance.now() < end) {} // синхронно займаємо єдиний потік JS
        return sendJson(res, 200, { blockedMs: ms })
      }
      const buffered = pathname.match(/^\/api\/debug\/replay-buffered\/([^/]+)$/)
      if (buffered) {
        const file = replayPath(config.logDir, buffered[1])
        if (!file) throw new HttpError(400, 'bad replay id')
        const data = await readFile(file) // увесь файл у пам’ять — саме так НЕ треба
        res.writeHead(200, { 'Content-Type': MIME['.ndjson'], 'Content-Length': data.length })
        return res.end(data)
      }
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
    if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, config.clientDist)
    throw new HttpError(405, 'method not allowed')
  }

  return async (req, res) => {
    try {
      await routes(req, res, new URL(req.url, 'http://localhost'))
    } catch (err) {
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return // клієнт пішов посеред завантаження — норма
      const status = err instanceof HttpError ? err.status : err instanceof RoomError ? 409 : 500
      if (status === 500) log('error', 'http.error', { url: req.url, err: err.stack })
      if (res.headersSent) return res.destroy()
      sendJson(res, status, { error: status === 500 ? 'internal error' : err.message })
    }
  }
}
