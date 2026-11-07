import { CodecError, decodeInput } from 'shared/net/binary.js'

// Протокол v1 (JSON, текстові кадри). Сервер НІКОЛИ не довіряє формі повідомлення клієнта.
//
// клієнт → сервер:
//   { v: 1, type: 'join', room: string ≤32, name: string ≤16 }
//   { v: 1, type: 'chat', text: string ≤200 }
//   { v: 1, type: 'leave' }
//   { v: 1, type: 'input', seq, thrust, turn, fire }   — лише з ?codec=json; інакше бінарний input (shared/net/binary.js)
//   { v: 1, type: 'ping', t }                          — для RTT у netgraph
//   { v: 1, type: 'netsim', lag, jitter, drop }        — лише в розробці: штучна затримка/розкид/втрата
// сервер → клієнт:
//   { type: 'welcome', playerId, room }        { type: 'roster', players: [{ id, name }] }
//   { type: 'chat', from: { id, name }, text, t } { type: 'system', text }
//   { type: 'error', code, message }            { type: 'shutdown' }
//   { type: 'match', shipId, tickRate, arena }  { type: 'pong', t }
//   знімок світу — бінарний кадр (або { type: 'snapshot', … } з ?codec=json)

export const PROTOCOL_VERSION = 1
export const LIMITS = { name: 16, room: 32, text: 200 }

// Коди закриття. 1xxx — стандартні (RFC 6455), 4xxx — наші (запам’ятовуються як HTTP).
export const CLOSE = {
  normal: 1000,
  goingAway: 1001, // сервер вимикається
  tooBig: 1009,
  badMessage: 4400,
  roomNotFound: 4404,
  joinTimeout: 4408,
  roomFull: 4409,
  rateLimited: 4429,
}

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max

// Кожна схема повертає «чисте» повідомлення лише з відомими полями або null.
const SCHEMAS = {
  join: (m) =>
    text(m.room, LIMITS.room) && text(m.name, LIMITS.name)
      ? { type: 'join', room: m.room, name: m.name.trim() }
      : null,
  chat: (m) => (text(m.text, LIMITS.text) ? { type: 'chat', text: m.text.trim() } : null),
  leave: () => ({ type: 'leave' }),
  input: (m) =>
    Number.isInteger(m.seq) &&
    m.seq >= 0 &&
    m.seq <= 0xffffffff &&
    typeof m.thrust === 'boolean' &&
    typeof m.fire === 'boolean' &&
    [-1, 0, 1].includes(m.turn)
      ? { type: 'input', seq: m.seq, thrust: m.thrust, fire: m.fire, turn: m.turn }
      : null,
  ping: (m) => (Number.isFinite(m.t) ? { type: 'ping', t: m.t } : null),
  netsim: (m) => {
    const ok = (v, max) => Number.isFinite(v) && v >= 0 && v <= max
    return ok(m.lag, 1000) && ok(m.jitter, 500) && ok(m.drop, 0.5)
      ? { type: 'netsim', lag: m.lag, jitter: m.jitter, drop: m.drop }
      : null
  },
}

const fail = (code, reason) => ({ ok: false, code, reason })

export function parseClientMessage(data, isBinary, maxBytes = 4096) {
  if (data.length > maxBytes) return fail(CLOSE.tooBig, 'message too big')
  if (isBinary) {
    // єдиний бінарний тип від клієнта — input; декодер перевіряє версію, довжину й діапазони
    try {
      return { ok: true, msg: decodeInput(data) }
    } catch (err) {
      if (err instanceof CodecError) return fail(CLOSE.badMessage, err.message)
      throw err
    }
  }
  let msg
  try {
    msg = JSON.parse(data.toString('utf8'))
  } catch {
    return fail(CLOSE.badMessage, 'invalid json')
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return fail(CLOSE.badMessage, 'message must be an object')
  }
  if (msg.v !== PROTOCOL_VERSION) return fail(CLOSE.badMessage, 'unsupported protocol version')
  if (!Object.hasOwn(SCHEMAS, msg.type)) return fail(CLOSE.badMessage, 'unknown message type')
  const clean = SCHEMAS[msg.type](msg)
  return clean ? { ok: true, msg: clean } : fail(CLOSE.badMessage, `bad ${msg.type} message`)
}
