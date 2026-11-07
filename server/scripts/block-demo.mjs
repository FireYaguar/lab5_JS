// Що буде, якщо HTTP-обробник займе цикл подій на 300 мс?
// Двоє гравців у кімнаті: A шле чат кожні 150 мс, B міряє затримку доставки. Паралельно /health кожні 100 мс.
// Спершу 3 с норми, потім тричі GET /api/debug/block?ms=300.
// Запуск: npm run bench:block -w server
import { WebSocket } from 'ws'
import { startServer } from './_server.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const server = await startServer(3101)
const ws = (name) =>
  new Promise((resolve) => {
    const s = new WebSocket(`${server.base.replace('http', 'ws')}/ws`)
    s.on('open', () => {
      s.send(JSON.stringify({ v: 1, type: 'join', room: 'classic', name }))
      resolve(s)
    })
  })
const [a, b] = await Promise.all([ws('A'), ws('B')])

let phase = 'baseline'
const chat = { baseline: [], blocked: [] }
const health = { baseline: [], blocked: [] }
b.on('message', (d) => {
  const m = JSON.parse(d)
  if (m.type === 'chat') chat[phase].push(performance.now() - Number(m.text))
})
const sender = setInterval(
  () => a.send(JSON.stringify({ v: 1, type: 'chat', text: String(performance.now()) })),
  150,
)
const prober = setInterval(async () => {
  const t = performance.now()
  const p = phase
  await fetch(`${server.base}/health`)
  health[p].push(performance.now() - t)
}, 100)

await wait(3000)
phase = 'blocked'
for (let i = 0; i < 3; i++) {
  fetch(`${server.base}/api/debug/block?ms=300`)
  await wait(1000)
}
clearInterval(sender)
clearInterval(prober)
await wait(400)

const stat = (xs) => {
  const s = [...xs].sort((x, y) => x - y)
  return `n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(1)} мс max=${s[s.length - 1].toFixed(1)} мс`
}
console.log('чат  норма   :', stat(chat.baseline))
console.log('чат  з блоком:', stat(chat.blocked))
console.log('/health норма   :', stat(health.baseline))
console.log('/health з блоком:', stat(health.blocked))
a.close()
b.close()
console.log('SIGTERM →', await server.stop())
