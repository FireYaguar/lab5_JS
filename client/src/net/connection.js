// Обгортка WebSocket: черга send, поки з’єднання немає; розбір повідомлень за type;
// повторне підключення з дедалі довшою паузою (exponential backoff + jitter, як withRetry з Lab 3).
// Події: 'status' ({ state, delay? }), 'open', 'close' ({ code, reason }), 'binary' (ArrayBuffer — знімок, Lab 5),
// і за type JSON-повідомлення: 'roster', 'chat', 'match', 'pong', 'snapshot' (з ?codec=json)…

const NO_RECONNECT = new Set([1000, 4400, 4404, 4408, 4409]) // нормальне закриття або наша помилка — повтор не допоможе
const MAX_QUEUE = 100

export function wsUrl(path = '/ws') {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

export class Connection extends EventTarget {
  #url
  #ws = null
  #queue = []
  #attempt = 0
  #timer = 0
  #stopped = false
  #baseMs
  #maxMs
  bytesIn = 0 // лічильники для netgraph (корисне навантаження, без заголовків кадрів WebSocket)
  bytesOut = 0

  constructor(url, { baseMs = 500, maxMs = 10_000 } = {}) {
    super()
    this.#url = url
    this.#baseMs = baseMs
    this.#maxMs = maxMs
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  connect() {
    if (this.#stopped) return
    const ws = new WebSocket(this.#url)
    ws.binaryType = 'arraybuffer' // бінарні кадри одразу як ArrayBuffer → DataView
    this.#ws = ws
    this.#emit('status', { state: 'connecting' })

    ws.addEventListener('open', () => {
      this.#attempt = 0
      this.#emit('status', { state: 'open' })
      this.#emit('open') // гра шле join тут — він піде раніше за накопичену чергу
      for (const data of this.#queue.splice(0)) ws.send(data)
    })
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength
        this.#emit('binary', e.data)
        return
      }
      this.bytesIn += e.data.length // JSON у нас ASCII → символи ≈ байти
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return // сервер теж може помилитись — не валимо клієнт
      }
      if (typeof msg?.type === 'string') this.#emit(msg.type, msg)
    })
    ws.addEventListener('close', (e) => {
      this.#emit('close', { code: e.code, reason: e.reason })
      if (this.#stopped || NO_RECONNECT.has(e.code)) {
        this.#emit('status', { state: 'closed', code: e.code, reason: e.reason })
        return
      }
      this.#scheduleReconnect()
    })
    // 'error' у браузерному WebSocket не має деталей, за ним завжди йде 'close' — там і обробляємо
  }

  #scheduleReconnect() {
    const delay = Math.min(this.#maxMs, this.#baseMs * 2 ** this.#attempt) * (0.5 + Math.random())
    this.#attempt += 1
    this.#emit('status', { state: 'reconnecting', delay, attempt: this.#attempt })
    this.#timer = setTimeout(() => this.connect(), delay)
  }

  // Input не ставимо в чергу: застарілий input після реконекту гірший, ніж жодного.
  sendRaw(data) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength
    this.#ws.send(data)
    return true
  }

  send(msg) {
    const data = JSON.stringify({ v: 1, ...msg })
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.bytesOut += data.length
      this.#ws.send(data)
    } else if (this.#queue.length < MAX_QUEUE) this.#queue.push(data) // відправимо після (пере)підключення
  }

  close() {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.#ws?.close(1000, 'bye')
  }
}
