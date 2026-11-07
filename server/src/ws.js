import { codecs } from 'shared/net/codec.js'
import { WebSocketServer } from 'ws'
import { log } from './log.js'
import { CLOSE, parseClientMessage } from './protocol.js'
import { createTokenBucket } from './ratelimit.js'

// Життєвий цикл WebSocket-з’єднання: join за 5 с, перевірка кожного повідомлення, rate limit,
// heartbeat (ping раз на 15 с, два пропущені pong → розрив), політика повільного клієнта.
// Lab 5: input (бінарний або JSON) → черга Match; знімки → клієнту його кодеком (?codec=json|binary);
// у розробці — штучна затримка/розкид/втрата (?lag=&jitter=&drop= або повідомлення netsim).

let nextPlayerId = 1

export function attachWebSocket(server, { config, rooms }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes })
  const conns = new Map() // ws → стан з’єднання
  let closing = false

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname !== '/ws' || closing) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('error', (err) => log('error', 'wss.error', { err: err.message }))
  wss.on('connection', onConnection)

  function closeWith(ws, code, reason) {
    log('warn', 'ws.rejected', { code, reason, player: conns.get(ws)?.player?.id })
    ws.close(code, reason)
  }

  // Повільний клієнт: bufferedAmount — скільки байт ще не пішло в мережу для цього сокета.
  function send(ws, state, data, { critical = true } = {}) {
    if (ws.readyState !== ws.OPEN) return
    if (ws.bufferedAmount > config.hardBufferBytes) {
      log('warn', 'ws.slow_client.terminated', {
        player: state.player?.id,
        buffered: ws.bufferedAmount,
      })
      ws.terminate()
      return
    }
    if (!critical && ws.bufferedAmount > config.softBufferBytes) {
      state.dropped += 1 // чат почекає — роздувати чергу в пам’яті сервера не будемо
      return
    }
    ws.send(data)
  }

  function onConnection(ws, req) {
    const query = new URL(req.url, 'http://localhost').searchParams
    const num = (k, max) => Math.min(max, Math.max(0, Number(query.get(k)) || 0))
    const state = {
      codec: query.get('codec') === 'json' ? codecs.json : codecs.binary,
      // штучна мережа лише в розробці; у production завжди нулі
      netsim: config.debugRoutes
        ? { lag: num('lag', 1000), jitter: num('jitter', 500), drop: num('drop', 0.5) }
        : { lag: 0, jitter: 0, drop: 0 },
      inputBucket: createTokenBucket({ rate: 45, burst: 45 }), // 30 input/с + запас на розкид
      player: null,
      room: null,
      missedPongs: 0,
      dropped: 0,
      bucket: createTokenBucket({ rate: config.rateLimitPerSec, burst: config.rateLimitBurst }),
    }
    conns.set(ws, state)
    log('debug', 'ws.connected', { ip: req.socket.remoteAddress })

    // 'error' без слухача = виняток = падіння ВСЬОГО сервера, тому слухач на кожному сокеті
    ws.on('error', (err) => log('warn', 'ws.error', { err: err.message, code: err.code }))
    ws.on('pong', () => {
      state.missedPongs = 0
    })

    const joinTimer = setTimeout(
      () => closeWith(ws, CLOSE.joinTimeout, 'join timeout'),
      config.joinTimeoutMs,
    )

    // Штучна мережа: кожен напрямок отримує lag/2 ± jitter/2 (разом RTT ≈ lag); розкид може переставити порядок.
    const later = (fn) => {
      const { lag, jitter } = state.netsim
      if (lag === 0 && jitter === 0) return fn()
      setTimeout(fn, Math.max(0, lag / 2 + (Math.random() * 2 - 1) * (jitter / 2)))
    }
    const lost = () => state.netsim.drop > 0 && Math.random() < state.netsim.drop

    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== ws.OPEN) return // уже закриваємо — хвіст повідомлень ігноруємо
      const parsed = parseClientMessage(data, isBinary, config.maxPayloadBytes)
      const bucket = parsed.ok && parsed.msg.type === 'input' ? state.inputBucket : state.bucket
      if (!bucket.take()) return closeWith(ws, CLOSE.rateLimited, 'rate limit exceeded')
      if (!parsed.ok) return closeWith(ws, parsed.code, parsed.reason)
      const { msg } = parsed
      if (msg.type === 'input') {
        if (!state.room) return closeWith(ws, CLOSE.badMessage, 'join first')
        if (lost()) return // «втрачений пакет»: сервер цього input не побачить
        return later(() => state.room?.match?.pushInput(state.player.id, msg))
      }
      if (msg.type === 'ping') {
        return later(() => later(() => send(ws, state, JSON.stringify({ type: 'pong', t: msg.t }))))
      }
      if (msg.type === 'netsim') {
        if (config.debugRoutes) state.netsim = { lag: msg.lag, jitter: msg.jitter, drop: msg.drop }
        return
      }

      switch (msg.type) {
        case 'join': {
          if (state.room) return closeWith(ws, CLOSE.badMessage, 'already joined')
          const room = rooms.get(msg.room)
          if (!room) return closeWith(ws, CLOSE.roomNotFound, 'room not found')
          if (room.size >= room.maxPlayers) return closeWith(ws, CLOSE.roomFull, 'room is full')
          clearTimeout(joinTimer)
          const player = {
            id: `p${nextPlayerId++}`,
            name: msg.name,
            send: (payload, options) => send(ws, state, payload, options),
            // знімок некритичний: повільному клієнту його можна пропустити, наступний однаково прийде
            sendSnapshot: (snapshot) => {
              if (lost()) return
              const data = state.codec.encodeSnapshot(snapshot)
              later(() => send(ws, state, data, { critical: false }))
            },
          }
          state.player = player
          state.room = room
          ws.send(JSON.stringify({ type: 'welcome', playerId: player.id, room }))
          room.join(player)
          log('info', 'player.joined', { room: room.id, player: player.id })
          return
        }
        case 'chat':
          if (!state.room) return closeWith(ws, CLOSE.badMessage, 'join first')
          return state.room.chat(state.player.id, msg.text)
        case 'leave':
          return ws.close(CLOSE.normal, 'bye')
        default:
          return closeWith(ws, CLOSE.badMessage, 'unknown message type')
      }
    })

    ws.on('close', (code) => {
      clearTimeout(joinTimer)
      if (state.room) {
        state.room.leave(state.player.id, code === CLOSE.normal ? 'leave' : 'disconnect')
        log('info', 'player.left', { room: state.room.id, player: state.player.id, code })
      }
      conns.delete(ws)
    })
  }

  // Heartbeat: мертвий TCP (вимкнений Wi-Fi, NAT забув з’єднання) сам 'close' не надішле.
  const heartbeat = setInterval(() => {
    for (const [ws, state] of conns) {
      if (state.missedPongs >= 2) {
        log('warn', 'ws.heartbeat.timeout', { player: state.player?.id })
        ws.terminate()
        continue
      }
      state.missedPongs += 1
      ws.ping()
    }
  }, config.heartbeatMs)

  return {
    get connections() {
      return conns.size
    },
    // Graceful: попередити клієнтів (shutdown + 1001), дочекатися закриття, решту — terminate.
    async close(graceMs = 2000) {
      closing = true
      clearInterval(heartbeat)
      const closed = [...conns.keys()].map(
        (ws) =>
          new Promise((resolve) => {
            ws.once('close', resolve)
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'shutdown' }))
            ws.close(CLOSE.goingAway, 'server shutdown')
          }),
      )
      const timeout = new Promise((resolve) => setTimeout(resolve, graceMs).unref())
      await Promise.race([Promise.all(closed), timeout])
      for (const ws of conns.keys()) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}
