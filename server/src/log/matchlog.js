import { on } from 'node:events'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Об’єкти подій → рядки NDJSON (один JSON на рядок). Object mode на вході, байти на виході.
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true })
  }

  _transform(event, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(event)}\n`)
    } catch (err) {
      callback(err)
    }
  }
}

// Лог матчу: події кімнати → NDJSON → файл, через pipeline (backpressure, помилки й закриття — автоматично).
// Повертає шлях і проміс, що вирішується, коли все дописано на диск (подія 'matchEnd').
export function startMatchLog(room, dir) {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${room.id}-${stamp}.ndjson`)
  // on() підписується ОДРАЗУ (не ліниво в генераторі) — жодна подія між стартом і першим read не загубиться
  const events = on(room, 'event', { close: ['matchEnd'] })
  const source = Readable.from(
    (async function* () {
      for await (const [event] of events) yield event
    })(),
  )
  const done = pipeline(source, new NdjsonEncoder(), createWriteStream(file))
  return { file, done }
}
