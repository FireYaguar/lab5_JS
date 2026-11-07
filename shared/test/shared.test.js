import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CodecError,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
} from '../src/net/binary.js'
import { codecs } from '../src/net/codec.js'
import { buildSnapshot } from '../src/net/snapshot.js'
import { createArena } from '../src/sim/arena.js'
import { createPickup } from '../src/sim/components.js'
import { datan2, dcos, dsin } from '../src/sim/dmath.js'
import { runDeterminism } from '../src/sim/selftest.js'
import { Ship } from '../src/sim/ship.js'
import { stepShip, World } from '../src/sim/world.js'

describe('shared sim', () => {
  it('імпортується в Node без DOM (globalThis.window немає)', () => {
    assert.equal(typeof globalThis.window, 'undefined')
    assert.equal(typeof globalThis.document, 'undefined')
  })
  it('детермінізм: однаковий input → однаковий хеш', () => {
    const a = runDeterminism(1000)
    const b = runDeterminism(1000)
    assert.equal(a.hash, b.hash)
    assert.ok(a.scoreA + a.scoreB > 0, 'у сценарії є влучання')
  })
  it('детермінізм між рушіями: еталонний хеш (той самий у Chromium через ?exp=determinism)', () => {
    assert.equal(runDeterminism(1000).hash, '74fe05fb')
  })
  it('dsin/dcos/datan2 збігаються з Math з точністю ~1e-15', () => {
    for (let i = 0; i < 20000; i++) {
      const x = ((i * 0.000731) % 40) - 20
      assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 1e-15)
      assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 1e-15)
      assert.ok(Math.abs(datan2(x, 1.7 - (i % 7)) - Math.atan2(x, 1.7 - (i % 7))) < 1e-15)
    }
  })
  it('stepShip + syncFrom: повторне програвання input дає той самий стан', () => {
    const arena = createArena()
    const server = new Ship({ x: 100, y: 100 })
    const client = new Ship({ x: 100, y: 100 })
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      thrust: i % 3 !== 0,
      turn: (i % 5) - 2 > 0 ? 1 : 0,
      fire: false,
    }))
    for (const cmd of inputs) stepShip(server, cmd, 1 / 60, arena)
    for (const cmd of inputs.slice(0, 20)) stepShip(client, cmd, 1 / 60, arena)
    // знімок після input #20 → «сервер каже, де ти був», далі replay 21..50
    const mid = new Ship({ x: 100, y: 100 })
    for (const cmd of inputs.slice(0, 20)) stepShip(mid, cmd, 1 / 60, arena)
    client.syncFrom({
      ...mid,
      x: mid.pos.x,
      y: mid.pos.y,
      vx: mid.vel.x,
      vy: mid.vel.y,
      hp: mid.hp,
    })
    for (const cmd of inputs.slice(20)) stepShip(client, cmd, 1 / 60, arena)
    assert.equal(client.pos.x, server.pos.x)
    assert.equal(client.pos.y, server.pos.y)
  })
})

function sampleWorld() {
  const world = new World(createArena(), 7, { asteroids: 6 })
  const ships = [0, 1, 2, 3].map((i) => world.spawn(new Ship({ x: 300 + i * 300, y: 450 })))
  for (let i = 0; i < 6; i++) world.spawnAsteroid()
  world.spawn(createPickup({ x: 50, y: 50, effect: 'rapid' }))
  for (let i = 0; i < 30; i++) {
    for (const s of ships)
      world.applyInput(s, { seq: i, thrust: true, turn: 1, fire: true }, 1 / 60)
    world.stepOthers(1 / 60)
  }
  return world
}

describe('binary codec', () => {
  it('input: round-trip і рівно 8 байт', () => {
    const input = { seq: 123456, thrust: true, fire: false, turn: -1 }
    const buf = encodeInput(input)
    assert.equal(buf.byteLength, 8)
    assert.deepEqual(decodeInput(buf), { type: 'input', ...input })
    // Buffer з ненульовим byteOffset (як дає ws у Node)
    const pooled = Buffer.concat([Buffer.alloc(3), Buffer.from(buf)]).subarray(3)
    assert.equal(decodeInput(pooled).seq, 123456)
  })
  it('input: сміття → CodecError', () => {
    const bad = [
      new Uint8Array([1, 1, 0, 0]),
      new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0]),
      new Uint8Array([1, 1, 0, 0, 0, 0, 9, 0]),
      new Uint8Array([1, 1, 0, 0, 0, 0, 0, 5]),
    ]
    for (const b of bad) assert.throws(() => decodeInput(b), CodecError)
  })
  it('snapshot: round-trip у межах квантування', () => {
    const snap = buildSnapshot(sampleWorld(), 42, 17)
    const back = decodeSnapshot(encodeSnapshot(snap))
    assert.equal(back.tick, 42)
    assert.equal(back.ack, 17)
    assert.equal(back.entities.length, snap.entities.length)
    snap.entities.forEach((e, i) => {
      const d = back.entities[i]
      assert.equal(d.id, e.id)
      assert.equal(d.kind, e.kind)
      assert.ok(Math.abs(d.x - e.x) < 0.001 && Math.abs(d.y - e.y) < 0.001)
      if (e.angle !== undefined) {
        const diff = Math.atan2(Math.sin(d.angle - e.angle), Math.cos(d.angle - e.angle))
        assert.ok(Math.abs(diff) <= 0.00006, `${e.kind} angle`)
      }
      if (e.kind === 'ship') assert.equal(d.hp, e.hp)
      if (e.kind === 'pickup') assert.equal(d.effect, e.effect)
    })
  })
  it('snapshot: обрізаний буфер → CodecError, а не RangeError', () => {
    const buf = encodeSnapshot(buildSnapshot(sampleWorld(), 1, 1))
    assert.throws(() => decodeSnapshot(buf.slice(0, buf.byteLength - 3)), CodecError)
  })
  it('JSON-кодек: той самий знімок', () => {
    const snap = buildSnapshot(sampleWorld(), 5, 3)
    assert.deepEqual(
      codecs.json.decodeSnapshot(codecs.json.encodeSnapshot(snap)),
      JSON.parse(JSON.stringify(snap)),
    )
  })
})
