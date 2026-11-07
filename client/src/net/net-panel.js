// Панель «штучної мережі» (dev): затримка, розкид, втрата — сервер застосовує до цього з’єднання;
// затримка інтерполяції, передбачення, звірка, експеримент з Math.random() — живуть на клієнті.

export function readNetSettings(params) {
  const num = (k, def) => (params.has(k) ? Number(params.get(k)) : def)
  return {
    codec: params.get('codec') === 'json' ? 'json' : 'binary',
    prediction: params.get('pred') !== '0',
    reconcile: params.get('reconcile') !== '0',
    chaos: params.get('chaos') === '1',
    interpDelay: num('interp', 100),
    lag: num('lag', 0),
    jitter: num('jitter', 0),
    drop: num('drop', 0),
  }
}

export function netQuery(s) {
  return `codec=${s.codec}&lag=${s.lag}&jitter=${s.jitter}&drop=${s.drop}`
}

export function mountNetPanel(root, conn, settings) {
  const panel = document.createElement('div')
  panel.className = 'panel net-panel'
  const slider = (key, label, max, step = 1, scale = 1) => `
    <label>${label} <output data-out="${key}">${Math.round(settings[key] * scale)}</output>
      <input type="range" data-key="${key}" min="0" max="${max}" step="${step}" value="${settings[key] * scale}" data-scale="${scale}" /></label>`
  const check = (key, label) =>
    `<label class="row"><input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}/> ${label}</label>`
  panel.innerHTML = `
    <b>netsim</b>
    ${slider('lag', 'lag, ms', 400, 10)}
    ${slider('jitter', 'jitter ±ms', 150, 5)}
    ${slider('drop', 'drop, %', 20, 1, 100)}
    ${slider('interpDelay', 'interp, ms', 300, 10)}
    ${check('prediction', 'prediction')}
    ${check('reconcile', 'reconciliation')}
    ${check('chaos', 'Math.random() у predict')}
    <label class="row">codec
      <select data-codec>
        <option value="binary" ${settings.codec === 'binary' ? 'selected' : ''}>binary</option>
        <option value="json" ${settings.codec === 'json' ? 'selected' : ''}>json</option>
      </select></label>`
  root.append(panel)

  const syncServer = () =>
    conn.send({ type: 'netsim', lag: settings.lag, jitter: settings.jitter, drop: settings.drop })
  panel.addEventListener('input', (e) => {
    const el = e.target
    const key = el.dataset.key
    if (!key) return
    if (el.type === 'checkbox') settings[key] = el.checked
    else {
      settings[key] = Number(el.value) / Number(el.dataset.scale)
      panel.querySelector(`[data-out="${key}"]`).textContent = el.value
    }
    if (['lag', 'jitter', 'drop'].includes(key)) syncServer()
  })
  panel.querySelector('[data-codec]').addEventListener('change', (e) => {
    // кодек обирається при підключенні — перезавантажуємо з параметром
    const params = new URLSearchParams(location.search)
    params.set('codec', e.target.value)
    location.search = params.toString()
  })
}
