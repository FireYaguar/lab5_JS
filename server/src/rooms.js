import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { TICK_RATE } from 'shared/net/constants.js'
import { startMatchLog } from './log/matchlog.js'
import { log } from './log.js'
import { Match } from './match.js'

export class RoomError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RoomError'
    this.code = code // 'not_found' | 'full' | 'limit'
  }
}

// Кімната — EventEmitter. Події: 'join' (player), 'leave' (player, reason), 'chat' (player, text),
// 'event' (запис для логу матчу), 'empty', 'matchEnd'.
// Гравець — { id, name, send(data, { critical }), sendSnapshot(snapshot) }: кімната не знає про WebSocket.
// Lab 5: у кімнати з гравцями є Match — авторитетна симуляція (створюється на першому join, зупиняється, коли порожньо).
export class Room extends EventEmitter {
  players = new Map()
  match = null

  constructor({ id, name, maxPlayers, arena, persistent = false }) {
    super()
    this.id = id
    this.name = name
    this.maxPlayers = maxPlayers
    this.arena = arena
    this.persistent = persistent // стандартні кімнати не видаляються, коли спорожніють
  }

  get size() {
    return this.players.size
  }

  toJSON() {
    const { id, name, maxPlayers, arena } = this
    return { id, name, players: this.size, maxPlayers, arena }
  }

  #record(type, data) {
    this.emit('event', { t: Date.now(), room: this.id, type, ...data })
  }

  broadcast(msg, options) {
    const data = JSON.stringify(msg) // серіалізуємо один раз на всіх
    for (const p of this.players.values()) p.send(data, options)
  }

  #roster() {
    const players = [...this.players.values()].map(({ id, name, shipId }) => ({ id, name, shipId }))
    this.broadcast({ type: 'roster', players })
  }

  join(player) {
    if (this.size >= this.maxPlayers) throw new RoomError('full', 'room is full')
    this.players.set(player.id, player)
    if (!this.match) {
      this.match = new Match(this)
      this.match.start()
    }
    player.shipId = this.match.addPlayer(player)
    player.send(
      JSON.stringify({
        type: 'match',
        shipId: player.shipId,
        tickRate: TICK_RATE,
        arena: this.arena,
      }),
    )
    this.emit('join', player) // слухачі виконуються синхронно, тут — старт логу матчу
    this.#record('join', { player: { id: player.id, name: player.name } })
    this.broadcast({ type: 'system', text: `${player.name} приєднався` }, { critical: false })
    this.#roster()
  }

  leave(playerId, reason = 'leave') {
    const player = this.players.get(playerId)
    if (!player) return
    this.players.delete(playerId)
    this.match?.removePlayer(playerId)
    this.emit('leave', player, reason)
    this.#record('leave', { player: { id: player.id, name: player.name }, reason })
    this.broadcast({ type: 'system', text: `${player.name} вийшов` }, { critical: false })
    this.#roster()
    if (this.size === 0) {
      this.match?.stop()
      this.match = null
      this.emit('matchEnd') // закриває лог матчу
      this.emit('empty')
    }
  }

  chat(playerId, text) {
    const player = this.players.get(playerId)
    if (!player) return
    const t = Date.now()
    this.emit('chat', player, text)
    this.#record('chat', { player: { id: player.id, name: player.name }, text })
    // чат некритичний: повільному клієнту його можна не надіслати
    this.broadcast(
      { type: 'chat', from: { id: player.id, name: player.name }, text, t },
      { critical: false },
    )
  }
}

const DEFAULT_ROOMS = [
  { id: 'classic', name: 'Classic', arena: { width: 1600, height: 900, asteroids: 6, seed: 2026 } },
  {
    id: 'belt',
    name: 'Asteroid Belt',
    arena: { width: 1800, height: 1000, asteroids: 14, seed: 7 },
  },
  {
    id: 'duel',
    name: 'Duel (small)',
    maxPlayers: 2,
    arena: { width: 1100, height: 650, asteroids: 3, seed: 42 },
  },
]
const UNUSED_ROOM_TTL_MS = 60_000

export class RoomManager {
  #rooms = new Map()
  #logs = new Set() // проміси pipeline логів, що ще пишуться
  #config

  constructor(config) {
    this.#config = config
  }

  createDefaults() {
    for (const r of DEFAULT_ROOMS) this.create({ ...r, persistent: true })
  }

  get size() {
    return this.#rooms.size
  }

  get playerCount() {
    let n = 0
    for (const r of this.#rooms.values()) n += r.size
    return n
  }

  list() {
    return [...this.#rooms.values()]
  }

  get(id) {
    return this.#rooms.get(id)
  }

  create({ id, name, arena, maxPlayers, persistent = false }) {
    if (this.#rooms.size >= this.#config.maxRooms) throw new RoomError('limit', 'too many rooms')
    const room = new Room({
      id: id ?? randomUUID().slice(0, 8),
      name,
      arena,
      maxPlayers: Math.min(
        maxPlayers ?? this.#config.maxPlayersPerRoom,
        this.#config.maxPlayersPerRoom,
      ),
      persistent,
    })
    // EventEmitter без слухача 'error' кидає виняток і валить процес — слухач є завжди
    room.on('error', (err) => log('error', 'room.error', { room: room.id, err: err.message }))
    room.on('join', () => this.#ensureMatchLog(room))
    room.on('empty', () => {
      if (!room.persistent) this.delete(room.id)
    })
    if (!persistent) {
      // кімната, в яку так ніхто й не зайшов, теж не живе вічно
      setTimeout(() => room.size === 0 && this.delete(room.id), UNUSED_ROOM_TTL_MS).unref()
    }
    this.#rooms.set(room.id, room)
    log('info', 'room.created', { room: room.id })
    return room
  }

  #ensureMatchLog(room) {
    if (room.logging) return
    room.logging = true
    room.once('matchEnd', () => {
      room.logging = false // наступний join почне новий файл, навіть поки старий ще дописується
    })
    const { file, done } = startMatchLog(room, this.#config.logDir)
    log('info', 'matchlog.start', { room: room.id, file })
    const tracked = done
      .then(() => log('info', 'matchlog.closed', { room: room.id, file }))
      .catch((err) => log('error', 'matchlog.error', { room: room.id, err: err.message }))
      .finally(() => this.#logs.delete(tracked))
    this.#logs.add(tracked)
  }

  delete(id) {
    const room = this.#rooms.get(id)
    if (!room) return
    this.#rooms.delete(id)
    room.match?.stop()
    room.emit('matchEnd')
    log('info', 'room.deleted', { room: id })
  }

  // Для graceful shutdown: закінчити всі матчі й дочекатися, поки логи допишуться на диск.
  async closeAll() {
    for (const room of this.#rooms.values()) {
      room.match?.stop()
      room.emit('matchEnd')
    }
    await Promise.allSettled([...this.#logs])
  }
}
