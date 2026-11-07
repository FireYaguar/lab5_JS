import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { after, describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { NdjsonEncoder } from '../src/log/matchlog.js'
import { readReplay, replayPath } from '../src/log/replay.js'
import { setLogLevel } from '../src/log.js'
import { CLOSE, parseClientMessage } from '../src/protocol.js'
import { createTokenBucket } from '../src/ratelimit.js'
import { RoomManager } from '../src/rooms.js'

setLogLevel('silent')
const buf = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))

describe('protocol', () => {
  it('приймає валідні повідомлення і відкидає зайві поля', () => {
    const r = parseClientMessage(
      buf({ v: 1, type: 'join', room: 'classic', name: ' Ann ', admin: true }),
    )
    assert.deepEqual(r, { ok: true, msg: { type: 'join', room: 'classic', name: 'Ann' } })
  })
  it('невідомий тип, зламана форма, битий JSON, версія → 4400', () => {
    for (const raw of [
      { v: 1, type: 'teleport' },
      { v: 1, type: 'chat', text: 42 },
      { v: 1, type: 'chat', text: 'x'.repeat(201) },
      { v: 2, type: 'leave' },
      [1, 2],
      '{"v":1,',
      { v: 1, type: '__proto__' },
    ]) {
      assert.equal(parseClientMessage(buf(raw)).code, CLOSE.badMessage, JSON.stringify(raw))
    }
  })
  it('бінарне сміття → 4400, завеликий → 1009', () => {
    assert.equal(parseClientMessage(buf('{}'), true).code, CLOSE.badMessage)
    assert.equal(parseClientMessage(buf('x'.repeat(5000)), false, 4096).code, CLOSE.tooBig)
  })
})

describe('token bucket', () => {
  it('пропускає burst, далі — rate за секунду', () => {
    let t = 0
    const b = createTokenBucket({ rate: 10, burst: 3, now: () => t })
    assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false])
    t += 100 // +1 токен
    assert.deepEqual([b.take(), b.take()], [true, false])
  })
})

describe('config', () => {
  it('падає з поясненням на невалідному оточенні', () => {
    assert.throws(() => loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' }), /LOG_LEVEL[\s\S]*PORT/)
    assert.equal(loadConfig({}).port, 3000)
  })
})

describe('match log', () => {
  const dirs = []
  after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))))

  it('NdjsonEncoder: об’єкти → рядки; readReplay читає назад', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-'))
    dirs.push(dir)
    const file = join(dir, 'x.ndjson')
    const { createWriteStream } = await import('node:fs')
    const events = [
      { type: 'a', n: 1 },
      { type: 'b', text: 'привіт\nсвіт' },
    ]
    await pipeline(Readable.from(events), new NdjsonEncoder(), createWriteStream(file))
    assert.equal((await readFile(file, 'utf8')).split('\n').length, 3)
    const back = []
    for await (const e of readReplay(file)) back.push(e)
    assert.deepEqual(back, events)
  })

  it('кімната: join/chat/leave пишуться у файл, порожня кімната видаляється', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-'))
    dirs.push(dir)
    const manager = new RoomManager({ maxRooms: 5, maxPlayersPerRoom: 4, logDir: dir })
    const room = manager.create({ name: 'Test', arena: {} })
    const sent = []
    room.join({ id: 'p1', name: 'Ann', send: (d) => sent.push(JSON.parse(d)) })
    room.chat('p1', 'hello')
    room.leave('p1')
    assert.equal(manager.get(room.id), undefined, 'порожня кімната видалена')
    await manager.closeAll()
    const { listReplays } = await import('../src/log/replay.js')
    const [replay] = await listReplays(dir)
    const types = []
    for await (const e of readReplay(join(dir, `${replay.id}.ndjson`))) types.push(e.type)
    assert.deepEqual(types, ['join', 'chat', 'leave'])
    assert.ok(sent.some((m) => m.type === 'roster'))
  })

  it('replayPath відкидає ../ та інші символи', () => {
    assert.equal(replayPath('/logs', '../etc/passwd'), null)
    assert.equal(replayPath('/logs', 'a/b'), null)
    assert.equal(replayPath('/logs', 'classic-2026'), join('/logs', 'classic-2026.ndjson'))
  })
})
