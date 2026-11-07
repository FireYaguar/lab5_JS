import { createArena } from './arena.js'
import { Ship } from './ship.js'
import { World } from './world.js'

// Хеш стану світу (FNV-1a по байтах Float64). id не враховуються — лічильник id залежить від того,
// скільки сутностей уже створив процес, а не від симуляції.
export function hashWorld(world) {
  const f64 = new Float64Array(1)
  const bytes = new Uint8Array(f64.buffer)
  let h = 0x811c9dc5
  const mix = (v) => {
    f64[0] = v
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0
  }
  for (const e of world) {
    for (const ch of e.kind) mix(ch.charCodeAt(0))
    mix(e.pos.x)
    mix(e.pos.y)
    mix(e.vel.x)
    mix(e.vel.y)
    mix(e.angle)
    if (e.kind === 'ship') {
      mix(e.hp)
      mix(e.score)
    }
  }
  return h.toString(16).padStart(8, '0')
}

// Lab 5: однаковий скриптований input → однаковий хеш у Node і в браузері.
export function runDeterminism(steps = 1000, seed = 2026, { trace = false } = {}) {
  const hashes = []
  const world = new World(createArena(), seed, { asteroids: 6 })
  const a = world.spawn(new Ship({ x: 500, y: 450 }))
  const b = world.spawn(new Ship({ x: 1100, y: 450, angle: Math.PI / 2 }))
  for (let i = 0; i < 5; i++) world.spawnAsteroid()
  const commands = new Map()
  for (let i = 0; i < steps; i++) {
    commands.set(a.id, {
      seq: i,
      thrust: i % 90 < 50,
      turn: (Math.floor(i / 40) % 3) - 1,
      fire: i % 7 === 0,
    })
    commands.set(b.id, {
      seq: i,
      thrust: i % 60 < 20,
      turn: i % 200 < 100 ? 1 : 0,
      fire: i % 11 === 0,
    })
    world.step(1 / 60, commands)
    if (trace) hashes.push(hashWorld(world))
  }
  if (trace)
    return {
      hashes,
      dump: [...world].map((e) => [e.kind, e.pos.x, e.pos.y, e.vel.x, e.vel.y, e.angle]),
    }
  return { steps, hash: hashWorld(world), entities: world.size, scoreA: a.score, scoreB: b.score }
}
