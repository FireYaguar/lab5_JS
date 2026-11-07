import { STEP, SUBSTEPS, TICK_MS, TICK_RATE } from 'shared/net/constants.js'
import { buildSnapshot } from 'shared/net/snapshot.js'
import { createArena } from 'shared/sim/arena.js'
import { Ship } from 'shared/sim/ship.js'
import { World } from 'shared/sim/world.js'

// Авторитетна гра кімнати. Клієнти шлють input, сервер — єдине джерело правди про стан світу.
//
// Кожен тік (30/с): для кожного гравця обробляємо input із черги (по одному на «кредит»), потім крок
// решти світу і знімок кожному клієнту з його ack (останній оброблений seq).
// Кредити: +1 за тік, максимум 4. Клієнт, що шле input частіше за 30/с (speedhack), швидше не полетить —
// зайве чекає в черзі, а переповнена черга відкидає найстаріше.

const MAX_CREDITS = 4
const MAX_QUEUE = 16
const STATS_WINDOW = 300 // останні 10 с тіків
const DRONE_COMMAND = { seq: 0, thrust: false, turn: 1, fire: false }

export class Match {
  #timer = null
  #next = 0
  #durations = new Float64Array(STATS_WINDOW)
  #lateness = new Float64Array(STATS_WINDOW)
  tick = 0
  players = new Map() // playerId → { player, ship, queue, credits, ack }

  constructor(room) {
    const { width, height, seed, asteroids } = room.arena
    this.world = new World(createArena(width, height), seed, { asteroids })
    // мішень без пілота, як у локальному режимі
    this.drone = this.world.spawn(new Ship({ x: width * 0.8, y: height * 0.3, name: 'drone' }))
    for (let i = 0; i < Math.min(5, asteroids); i++) this.world.spawnAsteroid()
  }

  addPlayer(player) {
    const p = this.world.safeSpot()
    const ship = this.world.spawn(new Ship({ x: p.x, y: p.y, name: player.name }))
    ship.shield = 1.5
    this.players.set(player.id, { player, ship, queue: [], credits: 1, ack: 0 })
    return ship.id
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId)
    if (!p) return
    this.world.despawn(p.ship.id)
    this.players.delete(playerId)
  }

  pushInput(playerId, input) {
    const p = this.players.get(playerId)
    if (!p || input.seq <= p.ack) return // застарілий або дубль (затримка з розкидом міняє порядок)
    const q = p.queue
    if (q.some((i) => i.seq === input.seq)) return
    let i = q.length
    while (i > 0 && q[i - 1].seq > input.seq) i--
    q.splice(i, 0, input) // черга завжди впорядкована за seq
    if (q.length > MAX_QUEUE) q.shift()
  }

  start() {
    this.#next = performance.now()
    this.#schedule()
  }

  stop() {
    clearTimeout(this.#timer)
    this.#timer = null
  }

  // Не setInterval: кожен тік ставиться на АБСОЛЮТНИЙ цільовий час start + n·33.3 мс,
  // тому запізнення одного тіку не накопичується в дрейф.
  #schedule() {
    this.#next += TICK_MS
    this.#timer = setTimeout(() => this.#tick(), Math.max(0, this.#next - performance.now()))
  }

  #tick() {
    const start = performance.now()
    const late = start - this.#next
    this.tick += 1

    for (const p of this.players.values()) {
      p.credits = Math.min(MAX_CREDITS, p.credits + 1)
      while (p.credits >= 1 && p.queue.length > 0) {
        const input = p.queue.shift()
        p.credits -= 1
        for (let s = 0; s < SUBSTEPS; s++) this.world.applyInput(p.ship, input, STEP)
        p.ack = input.seq
      }
    }
    for (let s = 0; s < SUBSTEPS; s++) {
      this.world.applyInput(this.drone, DRONE_COMMAND, STEP)
      this.world.stepOthers(STEP)
    }

    const base = buildSnapshot(this.world, this.tick, 0)
    for (const p of this.players.values()) p.player.sendSnapshot({ ...base, ack: p.ack })

    const i = this.tick % STATS_WINDOW
    this.#durations[i] = performance.now() - start
    this.#lateness[i] = late
    // сервер відстав більш ніж на 5 тіків (CPU зайнятий) — не «надолужуємо» пачкою, а йдемо від «зараз»
    if (performance.now() - this.#next > TICK_MS * 5) this.#next = performance.now()
    this.#schedule()
  }

  stats() {
    const n = Math.min(this.tick, STATS_WINDOW)
    const pct = (arr, p) => {
      const xs = Array.from(arr.subarray(0, n)).sort((a, b) => a - b)
      return xs.length
        ? Number(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(3))
        : 0
    }
    return {
      tickRate: TICK_RATE,
      tick: this.tick,
      players: this.players.size,
      entities: this.world.size,
      tickMs: { p50: pct(this.#durations, 0.5), p99: pct(this.#durations, 0.99) },
      lateMs: { p50: pct(this.#lateness, 0.5), p99: pct(this.#lateness, 0.99) },
    }
  }
}
