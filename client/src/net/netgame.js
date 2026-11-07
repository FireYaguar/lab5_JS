import { codecs } from 'shared/net/codec.js'
import { STEP, SUBSTEPS, TICK_MS } from 'shared/net/constants.js'
import { createArena, lerpWrapped, wrap } from 'shared/sim/arena.js'
import { Explosion } from 'shared/sim/entity.js'
import { mulberry32 } from 'shared/sim/random.js'
import { Ship } from 'shared/sim/ship.js'
import { stepShip } from 'shared/sim/world.js'
import { readControls } from '../input.js'
import { lerpAngle } from '../render/draw.js'

// Мережева гра (Lab 5). Сервер авторитетний; клієнт:
//  • шле input з seq кожен тік (30/с), ніколи не координати;
//  • ПЕРЕДБАЧАЄ свій корабель тим самим stepShip, що й сервер;
//  • на знімку — ЗВІРКА: стан сервера + повторне програвання непідтверджених input, поправка згладжується ~100 мс;
//  • чужі сутності малює В МИНУЛОМУ — інтерполяція між двома знімками (interpDelay);
//  • свої кулі показує одразу (передбачені), серверні копії своїх куль ховає.

const SMOOTH_TAU = 0.033 // с: за 100 мс лишається ~5% поправки
const SNAP_LIMIT = 200 // px: більший стрибок (респаун, загортання) не згладжуємо, а ставимо одразу
const CHAOS = 25 // px/с випадкового шуму в передбаченні — експеримент «Math.random() в integrate»

function wrappedDelta(d, size) {
  if (d > size / 2) return d - size
  if (d < -size / 2) return d + size
  return d
}

export function createNetGame({ conn, room, name, input, settings }) {
  const arena = createArena(room.arena.width, room.arena.height)
  const codec = codecs[settings.codec]
  const bus = new EventTarget() // ті самі події, що в локальному режимі: звук і HUD не знають про мережу
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }))

  const me = new Ship({ name }) // передбачений свій корабель (локальний id ≠ серверний)
  me.solid = false // до першого знімка не малюємо
  let shipId = null // id корабля на сервері
  let seq = 0
  const pending = [] // input, які сервер ще не підтвердив
  const prev = { x: 0, y: 0, angle: 0 } // стан перед останнім тіком — для інтерполяції рендеру
  const smooth = { x: 0, y: 0 } // візуальна поправка, що згасає до 0
  const myBullets = new Map() // seq → { bullet, seen }
  const explosions = new Map() // id → Explosion (косметика клієнта)
  const buffer = [] // останні знімки { time, tick, map }
  let latest = null
  let clockOffset = null // серверний час − performance.now()
  let lastFrame = performance.now()

  const stats = {
    rtt: 0,
    snapshotAt: 0,
    snapshotsPerSec: 0,
    downBps: 0,
    upBps: 0,
    correction: 0,
    correctionMax: 0,
    corrections: [], // [ms, px] за останні 3 с — для графіка
    inputLatency: null,
    tick: 0,
    entities: 0,
  }

  // ---------- мережа ----------
  conn.addEventListener('match', (e) => {
    shipId = e.detail.shipId
  })
  conn.addEventListener('pong', (e) => {
    stats.rtt = performance.now() - e.detail.t
  })
  conn.addEventListener('binary', (e) => onSnapshot(codecs.binary.decodeSnapshot(e.detail)))
  conn.addEventListener('snapshot', (e) => onSnapshot(e.detail)) // ?codec=json
  conn.addEventListener('open', () => {
    pending.length = 0 // новий сокет — новий корабель на сервері
    latest = null
    buffer.length = 0
    conn.send({ type: 'netsim', lag: settings.lag, jitter: settings.jitter, drop: settings.drop })
  })

  let snapsThisSecond = 0
  let lastIn = 0
  let lastOut = 0
  setInterval(() => conn.send({ type: 'ping', t: performance.now() }), 500)
  setInterval(() => {
    stats.snapshotsPerSec = snapsThisSecond
    snapsThisSecond = 0
    stats.downBps = conn.bytesIn - lastIn
    stats.upBps = conn.bytesOut - lastOut
    lastIn = conn.bytesIn
    lastOut = conn.bytesOut
  }, 1000)

  function predict(cmd) {
    const bullet = stepShip(me, cmd, STEP, arena)
    if (settings.chaos && me.solid) {
      // НАВМИСНО недетерміновано: клієнт рахує не так, як сервер → поправки ростуть
      me.vel.x += (Math.random() - 0.5) * CHAOS
      me.vel.y += (Math.random() - 0.5) * CHAOS
    }
    return bullet
  }

  function reconcile(own, ack) {
    const old = {
      x: me.pos.x,
      y: me.pos.y,
      hp: me.hp,
      score: me.score,
      shield: me.shield,
      rapid: me.rapid,
      homing: me.homingShots,
      solid: me.solid,
    }
    me.syncFrom(own) // 1. «насправді ти був тут» (стан після input #ack)
    while (pending.length && pending[0].seq <= ack) pending.shift() // 2. підтверджене — викинути
    if (settings.prediction && settings.reconcile) {
      for (const cmd of pending) for (let s = 0; s < SUBSTEPS; s++) predict(cmd) // 3. переграти решту
    }
    if (!settings.prediction) return

    const dx = wrappedDelta(me.pos.x - old.x, arena.width)
    const dy = wrappedDelta(me.pos.y - old.y, arena.height)
    const dist = Math.hypot(dx, dy)
    if (old.solid && me.solid && dist < SNAP_LIMIT) {
      // візуально нічого не стрибає: зсув переносимо в smooth, який згасне за ~100 мс
      smooth.x -= dx
      smooth.y -= dy
      prev.x += dx
      prev.y += dy
    } else {
      smooth.x = 0
      smooth.y = 0
      prev.x = me.pos.x
      prev.y = me.pos.y
      prev.angle = me.angle
    }
    if (old.solid && me.solid) {
      stats.correction = dist
      stats.corrections.push([performance.now(), dist])
    }

    // події для звуку й HUD — з різниці станів
    if (me.hp < old.hp) emit('hit', { targetId: me.id, damage: old.hp - me.hp, blocked: false })
    if (me.score > old.score) emit('scored', { shipId: me.id, points: me.score - old.score })
    if (me.shield > old.shield + 1 && old.solid && me.solid)
      emit('picked', { shipId: me.id, effect: 'shield' })
    if (me.rapid > old.rapid + 1) emit('picked', { shipId: me.id, effect: 'rapid' })
    if (me.homingShots > old.homing + 1) emit('picked', { shipId: me.id, effect: 'homing' })
  }

  function onSnapshot(snap) {
    if (latest && snap.tick <= latest.tick) return // розкид затримки переставив порядок — старе ігноруємо
    latest = snap
    snapsThisSecond += 1
    stats.snapshotAt = performance.now()
    stats.tick = snap.tick
    stats.entities = snap.entities.length

    const time = snap.tick * TICK_MS
    const sample = time - performance.now()
    // орієнтуємось на НАЙШВИДШУ доставку; якщо затримка зросла — повільно підлаштовуємось
    clockOffset =
      clockOffset === null ? sample : Math.max(sample, clockOffset + (sample - clockOffset) * 0.02)
    const map = new Map()
    for (const e of snap.entities) map.set(e.id, e)
    buffer.push({ time, tick: snap.tick, map })
    while (buffer.length > 60) buffer.shift()

    const own = shipId !== null ? map.get(shipId) : null
    if (own) reconcile(own, snap.ack)

    // свої передбачені кулі ↔ серверні (за seq input-у)
    const onServer = new Set()
    for (const e of snap.entities)
      if (e.kind === 'bullet' && e.ownerId === shipId) onServer.add(e.seq)
    for (const [s, rec] of myBullets) {
      if (onServer.has(s)) rec.seen = true
      else if (rec.seen || s <= snap.ack) myBullets.delete(s) // сервер її знищив (влучання) або не випустив
    }
  }

  // ---------- тік клієнта (30/с) ----------
  let turnWas = 0
  let latencyProbe = null // затримка input → екран: від натискання повороту до зміни кута на екрані

  function simulate() {
    const cmd = { ...readControls(input), seq: ++seq }
    input.consume()
    conn.sendRaw(codec.encodeInput(cmd))
    pending.push(cmd)
    if (pending.length > 120) pending.shift()

    // поворот, а не газ: кутової інерції немає, тож кут змінюється ЛИШЕ від input
    if (cmd.turn !== 0 && turnWas === 0 && shipId !== null)
      latencyProbe = { t0: performance.now(), angle: null }
    turnWas = cmd.turn

    prev.x = me.pos.x
    prev.y = me.pos.y
    prev.angle = me.angle
    if (settings.prediction && shipId !== null) {
      for (let s = 0; s < SUBSTEPS; s++) {
        const bullet = predict(cmd)
        if (bullet) {
          myBullets.set(cmd.seq, { bullet, seen: false })
          emit('fired', { shipId: me.id })
        }
      }
    }
    for (const [s, rec] of myBullets) {
      const b = rec.bullet
      b.savePrev()
      for (let i = 0; i < SUBSTEPS; i++) {
        b.update(STEP)
        wrap(b.pos, arena)
      }
      if (!b.alive) myBullets.delete(s)
    }
  }

  // ---------- рендер ----------
  function interpolated() {
    if (buffer.length === 0) return { a: null, b: null, t: 0 }
    const renderTime = performance.now() + clockOffset - settings.interpDelay
    let a = buffer[0]
    let b = buffer[0]
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].time <= renderTime) {
        a = buffer[i]
        b = buffer[i + 1] ?? buffer[i] // новішого ще немає — тримаємо останній (без екстраполяції)
        break
      }
    }
    const t =
      b.time > a.time ? Math.min(1, Math.max(0, (renderTime - a.time) / (b.time - a.time))) : 0
    return { a, b, t }
  }

  function items(alpha) {
    const now = performance.now()
    const dt = (now - lastFrame) / 1000
    lastFrame = now
    const k = Math.exp(-dt / SMOOTH_TAU)
    smooth.x *= k
    smooth.y *= k

    const list = []
    const { a, b, t } = interpolated()
    if (a) {
      for (const e of b.map.values()) {
        const mineShip = e.id === shipId
        if (settings.prediction && (mineShip || (e.kind === 'bullet' && e.ownerId === shipId)))
          continue
        if (e.kind === 'explosion') {
          if (!explosions.has(e.id)) {
            explosions.set(e.id, new Explosion({ x: e.x, y: e.y, rng: mulberry32(e.id) }))
            emit('exploded', { kind: 'unknown' })
          }
          continue
        }
        const ea = a.map.get(e.id)
        if (!ea) continue // з’явилась лише в новішому знімку — почекаємо, поки буде пара
        list.push({
          kind: e.kind,
          x: lerpWrapped(ea.x, e.x, t, arena.width),
          y: lerpWrapped(ea.y, e.y, t, arena.height),
          angle: e.angle === undefined ? 0 : lerpAngle(ea.angle, e.angle, t),
          mine: mineShip,
          src: e,
        })
      }
    }
    for (const [id, ex] of explosions) {
      ex.update(dt)
      if (!ex.alive) explosions.delete(id)
      else list.push({ kind: 'explosion', x: 0, y: 0, angle: 0, src: ex })
    }
    if (settings.prediction) {
      for (const { bullet } of myBullets.values()) {
        list.push({
          kind: 'bullet',
          x: lerpWrapped(bullet.prevX, bullet.pos.x, alpha, arena.width),
          y: lerpWrapped(bullet.prevY, bullet.pos.y, alpha, arena.height),
          angle: 0,
          src: bullet,
        })
      }
      if (me.solid) {
        const x = lerpWrapped(prev.x, me.pos.x, alpha, arena.width) + smooth.x
        const y = lerpWrapped(prev.y, me.pos.y, alpha, arena.height) + smooth.y
        list.push({
          kind: 'ship',
          x,
          y,
          angle: lerpAngle(prev.angle, me.angle, alpha),
          mine: true,
          src: me,
        })
      }
    }

    const mine = list.find((i) => i.mine)
    if (latencyProbe && mine) {
      if (latencyProbe.angle === null) latencyProbe.angle = mine.angle
      else if (Math.abs(mine.angle - latencyProbe.angle) > 0.001) {
        stats.inputLatency = now - latencyProbe.t0
        latencyProbe = null
      }
    }
    while (stats.corrections.length && stats.corrections[0][0] < now - 3000)
      stats.corrections.shift()
    stats.correctionMax = stats.corrections.reduce((m, c) => Math.max(m, c[1]), 0)
    return list
  }

  return {
    arena,
    bus,
    me,
    stats,
    settings,
    get pending() {
      return pending.length
    },
    get entityCount() {
      return stats.entities
    },
    simulate,
    items,
  }
}
