import { EFFECT_CODES, EFFECTS, KIND_CODES, KINDS } from './snapshot.js'

/*
 * БІНАРНИЙ ПРОТОКОЛ v1. Усі числа — LITTLE-ENDIAN (третій аргумент DataView = true).
 * Байт 0 — версія формату, байт 1 — тип повідомлення. Невідома версія/тип/довжина → CodecError.
 *
 * INPUT (клієнт → сервер), рівно 8 байт:
 *   0  u8   version = 1
 *   1  u8   type = 1
 *   2  u32  seq
 *   6  u8   buttons: bit0 = thrust, bit1 = fire (інші біти мають бути 0)
 *   7  i8   turn ∈ {−1, 0, 1}
 *
 * SNAPSHOT (сервер → клієнт): заголовок 12 байт + сутності
 *   0  u8   version = 1
 *   1  u8   type = 2
 *   2  u32  tick
 *   6  u32  ack — останній оброблений seq цього клієнта
 *   10 u16  кількість сутностей
 *   Кожна сутність — спільна частина 14 байт:
 *     u32 id | u8 kind (1 ship, 2 bullet, 3 asteroid, 4 pickup, 5 explosion) | u8 flags | f32 x | f32 y
 *     flags: bit0 solid, bit1 thrust, bit2 homing
 *   + за kind:
 *     ship      +25: i16 angle | f32 vx | f32 vy | u8 hp | u16 cooldown (мс) | u16 shield, rapid,
 *                    homingShots, respawnIn (сотні частки секунди) | u32 score          → 39 байт
 *     bullet     +8: u32 ownerId | u32 seq                                              → 22 байти
 *     asteroid   +4: i16 angle | u8 radius | u8 shape                                   → 18 байт
 *     pickup     +1: u8 effect (0 shield, 1 rapid, 2 homing)                            → 15 байт
 *     explosion  +0                                                                      → 14 байт
 *
 * Кут — Int16 у 1/10000 рад: діапазон ±3.2767 рад покриває (−π, π], крок 0.0001 рад
 * (на відстані 1000 px це 0.1 px — непомітно), 2 байти замість 4.
 */

export const VERSION = 1
export const TYPE = { input: 1, snapshot: 2 }
const LE = true
const ANGLE_SCALE = 10000
const HEADER = 12
const SIZE = { ship: 39, bullet: 22, asteroid: 18, pickup: 15, explosion: 14 }

export class CodecError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CodecError'
  }
}

const angleToI16 = (a) => Math.round(Math.atan2(Math.sin(a), Math.cos(a)) * ANGLE_SCALE)
const u16 = (v, scale) => Math.min(65535, Math.max(0, Math.round(v * scale)))

// ---------- input ----------

export function encodeInput({ seq, thrust, fire, turn }) {
  const view = new DataView(new ArrayBuffer(8))
  view.setUint8(0, VERSION)
  view.setUint8(1, TYPE.input)
  view.setUint32(2, seq, LE)
  view.setUint8(6, (thrust ? 1 : 0) | (fire ? 2 : 0))
  view.setInt8(7, turn)
  return view.buffer
}

// Декодер — це валідатор: сервер довіряє лише тому, що пройшло тут.
export function decodeInput(bytes) {
  const view = toView(bytes)
  if (view.byteLength !== 8) throw new CodecError(`input: expected 8 bytes, got ${view.byteLength}`)
  checkHeader(view, TYPE.input)
  const buttons = view.getUint8(6)
  const turn = view.getInt8(7)
  if (buttons > 3) throw new CodecError('input: unknown button bits')
  if (turn < -1 || turn > 1) throw new CodecError('input: turn out of range')
  return {
    type: 'input',
    seq: view.getUint32(2, LE),
    thrust: (buttons & 1) !== 0,
    fire: (buttons & 2) !== 0,
    turn,
  }
}

// ---------- snapshot ----------

export function encodeSnapshot({ tick, ack, entities }) {
  let size = HEADER
  for (const e of entities) size += SIZE[e.kind]
  const view = new DataView(new ArrayBuffer(size))
  view.setUint8(0, VERSION)
  view.setUint8(1, TYPE.snapshot)
  view.setUint32(2, tick, LE)
  view.setUint32(6, ack, LE)
  view.setUint16(10, entities.length, LE)
  let o = HEADER
  for (const e of entities) {
    view.setUint32(o, e.id, LE)
    view.setUint8(o + 4, KIND_CODES[e.kind])
    view.setUint8(o + 5, (e.solid === false ? 0 : 1) | (e.thrust ? 2 : 0) | (e.homing ? 4 : 0))
    view.setFloat32(o + 6, e.x, LE)
    view.setFloat32(o + 10, e.y, LE)
    o += 14
    switch (e.kind) {
      case 'ship':
        view.setInt16(o, angleToI16(e.angle), LE)
        view.setFloat32(o + 2, e.vx, LE)
        view.setFloat32(o + 6, e.vy, LE)
        view.setUint8(o + 10, e.hp)
        view.setUint16(o + 11, u16(e.cooldown, 1000), LE)
        view.setUint16(o + 13, u16(e.shield, 100), LE)
        view.setUint16(o + 15, u16(e.rapid, 100), LE)
        view.setUint16(o + 17, u16(e.homingShots, 100), LE)
        view.setUint16(o + 19, u16(e.respawnIn, 100), LE)
        view.setUint32(o + 21, e.score, LE)
        o += 25
        break
      case 'bullet':
        view.setUint32(o, e.ownerId, LE)
        view.setUint32(o + 4, e.seq, LE)
        o += 8
        break
      case 'asteroid':
        view.setInt16(o, angleToI16(e.angle), LE)
        view.setUint8(o + 2, Math.round(e.radius))
        view.setUint8(o + 3, e.shape)
        o += 4
        break
      case 'pickup':
        view.setUint8(o, EFFECT_CODES[e.effect])
        o += 1
        break
      default:
        break
    }
  }
  return view.buffer
}

export function decodeSnapshot(bytes) {
  const view = toView(bytes)
  try {
    checkHeader(view, TYPE.snapshot)
    const count = view.getUint16(10, LE)
    const entities = new Array(count)
    let o = HEADER
    for (let i = 0; i < count; i++) {
      const kind = KINDS[view.getUint8(o + 4)]
      if (!kind) throw new CodecError(`snapshot: unknown kind ${view.getUint8(o + 4)}`)
      const flags = view.getUint8(o + 5)
      const e = {
        id: view.getUint32(o, LE),
        kind,
        x: view.getFloat32(o + 6, LE),
        y: view.getFloat32(o + 10, LE),
      }
      o += 14
      switch (kind) {
        case 'ship':
          e.angle = view.getInt16(o, LE) / ANGLE_SCALE
          e.vx = view.getFloat32(o + 2, LE)
          e.vy = view.getFloat32(o + 6, LE)
          e.hp = view.getUint8(o + 10)
          e.solid = (flags & 1) !== 0
          e.thrust = (flags & 2) !== 0
          e.cooldown = view.getUint16(o + 11, LE) / 1000
          e.shield = view.getUint16(o + 13, LE) / 100
          e.rapid = view.getUint16(o + 15, LE) / 100
          e.homingShots = view.getUint16(o + 17, LE) / 100
          e.respawnIn = view.getUint16(o + 19, LE) / 100
          e.score = view.getUint32(o + 21, LE)
          o += 25
          break
        case 'bullet':
          e.homing = (flags & 4) !== 0
          e.ownerId = view.getUint32(o, LE)
          e.seq = view.getUint32(o + 4, LE)
          o += 8
          break
        case 'asteroid':
          e.angle = view.getInt16(o, LE) / ANGLE_SCALE
          e.radius = view.getUint8(o + 2)
          e.shape = view.getUint8(o + 3)
          e.homing = (flags & 4) !== 0
          o += 4
          break
        case 'pickup': {
          const effect = EFFECTS[view.getUint8(o)]
          if (!effect) throw new CodecError('snapshot: unknown effect')
          e.effect = effect
          o += 1
          break
        }
        default:
          break
      }
      entities[i] = e
    }
    if (o !== view.byteLength) throw new CodecError('snapshot: trailing bytes')
    return { type: 'snapshot', tick: view.getUint32(2, LE), ack: view.getUint32(6, LE), entities }
  } catch (err) {
    if (err instanceof RangeError) throw new CodecError('snapshot: truncated') // DataView вийшов за межі
    throw err
  }
}

// ---------- helpers ----------

// ws у Node дає Buffer (Uint8Array над спільним пулом) — враховуємо byteOffset; браузер дає ArrayBuffer.
function toView(bytes) {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes)
  if (ArrayBuffer.isView(bytes))
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  throw new CodecError('expected binary data')
}

function checkHeader(view, type) {
  if (view.byteLength < 2) throw new CodecError('too short')
  if (view.getUint8(0) !== VERSION) throw new CodecError(`unsupported version ${view.getUint8(0)}`)
  if (view.getUint8(1) !== type) throw new CodecError(`unexpected type ${view.getUint8(1)}`)
  if (type === TYPE.snapshot && view.byteLength < HEADER)
    throw new CodecError('snapshot: truncated header')
}

export function messageType(bytes) {
  const view = toView(bytes)
  return view.byteLength >= 2 ? view.getUint8(1) : 0
}
