// Панель кімнати: статус з’єднання, список гравців, чат. Лише слухає події Connection.

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const MAX_LINES = 8

export function mountChat(root, conn) {
  const panel = document.createElement('div')
  panel.className = 'panel chat'
  panel.innerHTML = `
    <div class="chat-status"></div>
    <div class="chat-roster"></div>
    <ul class="chat-log"></ul>
    <input class="chat-input" maxlength="200" placeholder="Enter — написати в чат" />`
  root.append(panel)
  const $ = (sel) => panel.querySelector(sel)
  const lines = []

  function addLine(html) {
    lines.push(html)
    if (lines.length > MAX_LINES) lines.shift()
    $('.chat-log').innerHTML = lines.map((l) => `<li>${l}</li>`).join('')
  }

  conn.addEventListener('status', (e) => {
    const { state, delay, code, reason } = e.detail
    const text = {
      connecting: 'підключення…',
      open: 'онлайн',
      reconnecting: `зв’язок втрачено, повтор через ${((delay ?? 0) / 1000).toFixed(1)} с`,
      closed: `закрито (${code}${reason ? `: ${reason}` : ''})`,
    }[state]
    $('.chat-status').textContent = text
    $('.chat-status').dataset.state = state
  })
  conn.addEventListener('roster', (e) => {
    $('.chat-roster').textContent = `У кімнаті: ${e.detail.players.map((p) => p.name).join(', ')}`
  })
  conn.addEventListener('chat', (e) =>
    addLine(`<b>${esc(e.detail.from.name)}:</b> ${esc(e.detail.text)}`),
  )
  conn.addEventListener('system', (e) => addLine(`<i>${esc(e.detail.text)}</i>`))
  conn.addEventListener('shutdown', () => addLine('<i>сервер перезапускається…</i>'))

  const input = $('.chat-input')
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      conn.send({ type: 'chat', text: input.value.trim() })
      input.value = ''
    }
    if (e.key === 'Escape' || e.key === 'Enter') input.blur() // повернути клавіатуру грі
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target !== input) {
      e.preventDefault()
      input.focus()
    }
  })
}
