// JSON vs бінарний: розмір знімка/input і час encode+decode на реалістичному світі (4 кораблі, що стріляють).
// Запуск: npm run bench -w shared
import { codecs } from '../src/net/codec.js'
import { STEP, SUBSTEPS, TICK_RATE } from '../src/net/constants.js'
import { buildSnapshot } from '../src/net/snapshot.js'
import { createArena } from '../src/sim/arena.js'
import { Ship } from '../src/sim/ship.js'
import { World } from '../src/sim/world.js'

const world = new World(createArena(), 2026, { asteroids: 6 })
const ships = [0, 1, 2, 3].map((i) => world.spawn(new Ship({ x: 250 + i * 350, y: 450 })))
for (let i = 0; i < 5; i++) world.spawnAsteroid()
const sizes = { json: [], binary: [] }
const timings = { json: [], binary: [] }
const bytes = (data) => (typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength)

for (let tick = 1; tick <= 900; tick++) {
  for (const [i, s] of ships.entries()) {
    const cmd = {
      seq: tick,
      thrust: (tick + i * 20) % 60 < 30,
      turn: ((Math.floor(tick / 45) + i) % 3) - 1,
      fire: tick % 4 === i,
    }
    for (let k = 0; k < SUBSTEPS; k++) world.applyInput(s, cmd, STEP)
  }
  for (let k = 0; k < SUBSTEPS; k++) world.stepOthers(STEP)
  const snap = buildSnapshot(world, tick, tick)
  for (const name of ['json', 'binary']) {
    const codec = codecs[name]
    const t0 = process.hrtime.bigint()
    const data = codec.encodeSnapshot(snap)
    codec.decodeSnapshot(name === 'json' ? data.toString() : data)
    const us = Number(process.hrtime.bigint() - t0) / 1000
    if (tick > 300) {
      sizes[name].push(bytes(data))
      timings[name].push(us) // перші 300 тіків — прогрів JIT
    }
  }
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
const input = { seq: 123456, thrust: true, fire: false, turn: 1 }
const inputBytes = {
  json: bytes(codecs.json.encodeInput(input)),
  binary: bytes(codecs.binary.encodeInput(input)),
}
console.log(`світ: ${world.size} сутностей у кінці; 600 знімків після прогріву`)
for (const name of ['json', 'binary']) {
  const avg = mean(sizes[name])
  console.log(
    `${name.padEnd(6)} знімок: середнє ${avg.toFixed(0)} Б (min ${Math.min(...sizes[name])}, max ${Math.max(...sizes[name])}) → ${((avg * TICK_RATE) / 1024).toFixed(2)} KB/s вниз; ` +
      `input ${inputBytes[name]} Б → ${((inputBytes[name] * TICK_RATE) / 1024).toFixed(2)} KB/s вгору; encode+decode медіана ${med(timings[name]).toFixed(1)} µs`,
  )
}
