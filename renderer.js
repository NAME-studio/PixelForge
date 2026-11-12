'use strict'

const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 56, 64]
const MAX_HISTORY = 120
const MAX_SIZE = 512

const PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
  '#ffffff', '#94b0c2', '#566c86', '#333c57', '#ef7d57', '#b13e53', '#a7f070', '#38b764'
]

const $ = (id) => document.getElementById(id)

const canvas = $('canvas')
const ctx = canvas.getContext('2d')
const workspace = $('workspace')
const hexInput = $('colorInput')
const nativeInput = $('nativeColor')
const swatch = $('colorSwatch')
const toastEl = $('toast')

const buf = document.createElement('canvas')
const bctx = buf.getContext('2d')

const state = {
  w: 32,
  h: 32,
  pixels: null,
  u32: null,
  imageData: null,
  color: '#ff4d6d',
  tool: 'pencil',
  scale: 16,
  ox: 0,
  oy: 0,
  grid: true,
  fileName: 'pixel-art'
}

const undoStack = []
const redoStack = []
const recents = []

const checker = document.createElement('canvas')
checker.width = 16
checker.height = 16
{
  const c = checker.getContext('2d')
  c.fillStyle = '#1b1f28'
  c.fillRect(0, 0, 16, 16)
  c.fillStyle = '#252b37'
  c.fillRect(0, 0, 8, 8)
  c.fillRect(8, 8, 8, 8)
}
let checkerPattern = null

const hover = { x: -1, y: -1 }
let drawing = null
let panning = null
let spaceDown = false
let toastTimer = null
let rafPending = false

/* ---------------- helpers ---------------- */

function hexToRgb(hex) {
  let v = String(hex).trim().replace(/^#/, '')
  if (v.length === 3) v = v.split('').map((ch) => ch + ch).join('')
  if (!/^[0-9a-f]{6}$/i.test(v)) return { r: 255, g: 77, b: 109 }
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16)
  }
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function clampSize(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 32
  return Math.max(1, Math.min(MAX_SIZE, n))
}

function toast(message) {
  toastEl.textContent = message
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200)
}

/* ---------------- canvas model ---------------- */

function allocate(w, h, data) {
  state.w = w
  state.h = h
  state.pixels = data || new Uint8ClampedArray(w * h * 4)
  state.u32 = new Uint32Array(state.pixels.buffer)
  buf.width = w
  buf.height = h
  state.imageData = bctx.createImageData(w, h)
  undoStack.length = 0
  redoStack.length = 0
  commit()
  updateHistoryButtons()
  updateInfo()
  fitView()
}

function commit() {
  if (!state.imageData) return
  state.imageData.data.set(state.pixels)
  bctx.putImageData(state.imageData, 0, 0)
  requestRender()
}

function paint(x, y, tool) {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return
  const i = (y * state.w + x) * 4
  if (tool === 'eraser') {
    state.pixels[i] = 0
    state.pixels[i + 1] = 0
    state.pixels[i + 2] = 0
    state.pixels[i + 3] = 0
  } else {
    const c = hexToRgb(state.color)
    state.pixels[i] = c.r
    state.pixels[i + 1] = c.g
    state.pixels[i + 2] = c.b
    state.pixels[i + 3] = 255
  }
}

function strokeLine(x0, y0, x1, y1, tool) {
  let dx = Math.abs(x1 - x0)
  let dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  for (;;) {
    paint(x0, y0, tool)
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
}

function floodFill(x, y, fillValue) {
  const w = state.w
  const h = state.h
  const u32 = state.u32
  const start = y * w + x
  const target = u32[start]
  if (target === fillValue) return
  const stack = [start]
  while (stack.length) {
    const i = stack.pop()
    if (u32[i] !== target) continue
    u32[i] = fillValue
    const cx = i % w
    const cy = (i - cx) / w
    if (cx > 0) stack.push(i - 1)
    if (cx < w - 1) stack.push(i + 1)
    if (cy > 0) stack.push(i - w)
    if (cy < h - 1) stack.push(i + w)
  }
}

function pickColor(x, y) {
  if (x < 0 || y < 0 || x >= state.w || y >= state.h) return
  const i = (y * state.w + x) * 4
  if (state.pixels[i + 3] === 0) {
    toast('Пиксель прозрачный')
    return
  }
  setColor(rgbToHex(state.pixels[i], state.pixels[i + 1], state.pixels[i + 2]))
}

/* ---------------- history ---------------- */

function pushHistory() {
  undoStack.push(new Uint8ClampedArray(state.pixels))
  if (undoStack.length > MAX_HISTORY) undoStack.shift()
  redoStack.length = 0
  updateHistoryButtons()
}

function undo() {
  if (!undoStack.length) return
  redoStack.push(new Uint8ClampedArray(state.pixels))
  state.pixels.set(undoStack.pop())
  commit()
  updateHistoryButtons()
}

function redo() {
  if (!redoStack.length) return
  undoStack.push(new Uint8ClampedArray(state.pixels))
  state.pixels.set(redoStack.pop())
  commit()
  updateHistoryButtons()
}

function updateHistoryButtons() {
  const u = $('undoBtn')
  const r = $('redoBtn')
  if (u) u.disabled = undoStack.length === 0
  if (r) r.disabled = redoStack.length === 0
}

/* ---------------- view ---------------- */

function requestRender() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    rafPending = false
    render()
  })
}

function render() {
  const dpr = window.devicePixelRatio || 1
  const cw = canvas.clientWidth
  const ch = canvas.clientHeight
  if (!cw || !ch) return

  const pw = Math.round(cw * dpr)
  const ph = Math.round(ch * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cw, ch)

  const w = state.w * state.scale
  const h = state.h * state.scale
  const ox = state.ox
  const oy = state.oy

  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 8
  ctx.fillStyle = '#000'
  ctx.fillRect(ox, oy, w, h)
  ctx.restore()

  if (!checkerPattern) checkerPattern = ctx.createPattern(checker, 'repeat')
  ctx.save()
  ctx.beginPath()
  ctx.rect(ox, oy, w, h)
  ctx.clip()
  ctx.fillStyle = checkerPattern
  ctx.translate(ox, oy)
  ctx.fillRect(0, 0, w, h)
  ctx.restore()

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(buf, ox, oy, w, h)

  if (state.grid && state.scale >= 6) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(ox, oy, w, h)
    ctx.clip()
    ctx.lineWidth = 1
    for (let x = 0; x <= state.w; x++) {
      const px = Math.round(ox + x * state.scale) + 0.5
      ctx.strokeStyle = x % 8 === 0 ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.055)'
      ctx.beginPath()
      ctx.moveTo(px, oy)
      ctx.lineTo(px, oy + h)
      ctx.stroke()
    }
    for (let y = 0; y <= state.h; y++) {
      const py = Math.round(oy + y * state.scale) + 0.5
      ctx.strokeStyle = y % 8 === 0 ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.055)'
      ctx.beginPath()
      ctx.moveTo(ox, py)
      ctx.lineTo(ox + w, py)
      ctx.stroke()
    }
    ctx.restore()
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 1
  ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1)

  if (!drawing && hover.x >= 0 && hover.y >= 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(
      ox + hover.x * state.scale + 0.75,
      oy + hover.y * state.scale + 0.75,
      state.scale - 1.5,
      state.scale - 1.5
    )
  }
}

function nearestZoomIndex(scale) {
  let best = 0
  let bestDiff = Infinity
  ZOOMS.forEach((z, i) => {
    const d = Math.abs(z - scale)
    if (d < bestDiff) {
      bestDiff = d
      best = i
    }
  })
  return best
}

function setScaleAt(newScale, cx, cy) {
  const px = cx === undefined ? workspace.clientWidth / 2 : cx
  const py = cy === undefined ? workspace.clientHeight / 2 : cy
  const ix = (px - state.ox) / state.scale
  const iy = (py - state.oy) / state.scale
  state.scale = newScale
  state.ox = px - ix * newScale
  state.oy = py - iy * newScale
  clampView()
  updateZoomLabels()
  requestRender()
}

function zoomStep(dir) {
  const i = nearestZoomIndex(state.scale)
  const ni = Math.max(0, Math.min(ZOOMS.length - 1, i + dir))
  if (ZOOMS[ni] === state.scale) return
  setScaleAt(ZOOMS[ni])
}

function clampView() {
  const wsW = workspace.clientWidth
  const wsH = workspace.clientHeight
  const w = state.w * state.scale
  const h = state.h * state.scale
  const margin = 80
  state.ox = Math.min(wsW - margin, Math.max(margin - w, state.ox))
  state.oy = Math.min(wsH - margin, Math.max(margin - h, state.oy))
}

function fitView() {
  const wsW = workspace.clientWidth
  const wsH = workspace.clientHeight
  if (!wsW || !wsH) return
  const raw = Math.min((wsW - 96) / state.w, (wsH - 96) / state.h)
  let best = ZOOMS[0]
  for (const z of ZOOMS) if (z <= raw) best = z
  state.scale = Math.max(1, best)
  state.ox = Math.round((wsW - state.w * state.scale) / 2)
  state.oy = Math.round((wsH - state.h * state.scale) / 2)
  updateZoomLabels()
  requestRender()
}

/* ---------------- ui state ---------------- */

function updateZoomLabels() {
  $('zoomValue').textContent = 'x' + state.scale
  $('zoomStatus').textContent = 'x' + state.scale
}

function updateInfo() {
  $('sizeStatus').textContent = `${state.w} x ${state.h}`
  $('newBtn').textContent = `Холст ${state.w} × ${state.h}`
  $('nameStatus').textContent = state.fileName
  $('gridBtn').textContent = state.grid ? 'Сетка: вкл' : 'Сетка: выкл'
  updateZoomLabels()
}

function updateCoord(cell) {
  if (cell && cell.x >= 0 && cell.y >= 0 && cell.x < state.w && cell.y < state.h) {
    $('coordStatus').textContent = `${cell.x}, ${cell.y}`
  } else {
    $('coordStatus').textContent = '—, —'
  }
}

function setTool(tool) {
  state.tool = tool
  document.querySelectorAll('.tool').forEach((el) => {
    el.classList.toggle('active', el.dataset.tool === tool)
  })
}

function setColor(hex, remember = true) {
  const rgb = hexToRgb(hex)
  state.color = rgbToHex(rgb.r, rgb.g, rgb.b)
  swatch.style.background = state.color
  hexInput.value = state.color.toUpperCase()
  nativeInput.value = state.color
  if (remember) rememberColor(state.color)
}

function rememberColor(hex) {
  const i = recents.indexOf(hex)
  if (i !== -1) recents.splice(i, 1)
  recents.unshift(hex)
  if (recents.length > 8) recents.pop()
  renderRecents()
}

function renderRecents() {
  const box = $('recent')
  box.innerHTML = ''
  recents.forEach((hex) => {
    const b = document.createElement('button')
    b.className = 'swatch'
    b.style.background = hex
    b.title = hex
    b.addEventListener('click', () => setColor(hex))
    box.appendChild(b)
  })
}

function buildPalette() {
  const box = $('palette')
  PALETTE.forEach((hex) => {
    const b = document.createElement('button')
    b.className = 'swatch'
    b.style.background = hex
    b.title = hex
    b.addEventListener('click', () => setColor(hex))
    box.appendChild(b)
  })
}

/* ---------------- pointer input ---------------- */

function cellFromEvent(e) {
  const rect = canvas.getBoundingClientRect()
  const x = Math.floor((e.clientX - rect.left - state.ox) / state.scale)
  const y = Math.floor((e.clientY - rect.top - state.oy) / state.scale)
  return { x, y }
}

function inBounds(cell) {
  return !!cell && cell.x >= 0 && cell.y >= 0 && cell.x < state.w && cell.y < state.h
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault())

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    panning = { x: e.clientX, y: e.clientY, ox: state.ox, oy: state.oy }
    workspace.classList.add('panning')
    return
  }
  if (e.button !== 0 && e.button !== 2) return

  const cell = cellFromEvent(e)
  if (!inBounds(cell)) return
  canvas.setPointerCapture(e.pointerId)

  const tool = e.button === 2 ? 'eraser' : e.altKey ? 'picker' : state.tool
  hover.x = cell.x
  hover.y = cell.y

  if (tool === 'picker') {
    pickColor(cell.x, cell.y)
    return
  }

  if (tool === 'fill') {
    const c = hexToRgb(state.color)
    const fillValue = ((255 << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0
    if (state.u32[cell.y * state.w + cell.x] === fillValue) return
    pushHistory()
    floodFill(cell.x, cell.y, fillValue)
    commit()
    return
  }

  pushHistory()
  drawing = { tool, last: cell }
  paint(cell.x, cell.y, tool)
  commit()
})

canvas.addEventListener('pointermove', (e) => {
  if (panning) {
    state.ox = panning.ox + (e.clientX - panning.x)
    state.oy = panning.oy + (e.clientY - panning.y)
    clampView()
    requestRender()
    return
  }

  const cell = cellFromEvent(e)
  if (inBounds(cell)) {
    hover.x = cell.x
    hover.y = cell.y
  } else {
    hover.x = -1
    hover.y = -1
  }
  updateCoord(cell)

  if (drawing) {
    if (!(cell.x === drawing.last.x && cell.y === drawing.last.y)) {
      strokeLine(drawing.last.x, drawing.last.y, cell.x, cell.y, drawing.tool)
      drawing.last = cell
      commit()
    }
  } else {
    requestRender()
  }
})

function endPointer(e) {
  if (panning) {
    panning = null
    workspace.classList.remove('panning')
  }
  if (drawing) {
    drawing = null
    requestRender()
  }
  try {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  } catch (_) {
    /* ignore */
  }
}

canvas.addEventListener('pointerup', endPointer)
canvas.addEventListener('pointercancel', endPointer)

canvas.addEventListener('pointerleave', () => {
  if (!drawing) {
    hover.x = -1
    hover.y = -1
    $('coordStatus').textContent = '—, —'
    requestRender()
  }
})

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const dir = e.deltaY < 0 ? 1 : -1
    const ni = Math.max(0, Math.min(ZOOMS.length - 1, nearestZoomIndex(state.scale) + dir))
    if (ZOOMS[ni] !== state.scale) {
      setScaleAt(ZOOMS[ni], e.clientX - rect.left, e.clientY - rect.top)
    }
  },
  { passive: false }
)

/* ---------------- colors ui ---------------- */

hexInput.addEventListener('change', () => {
  const v = hexInput.value.trim()
  if (/^#?[0-9a-f]{3}$/i.test(v) || /^#?[0-9a-f]{6}$/i.test(v)) {
    setColor(v.startsWith('#') ? v : '#' + v)
  } else {
    hexInput.value = state.color.toUpperCase()
    toast('Формат: #RRGGBB')
  }
})

hexInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hexInput.blur()
})

nativeInput.addEventListener('input', () => setColor(nativeInput.value))

swatch.addEventListener('click', () => nativeInput.click())

/* ---------------- files ---------------- */

function b64encode(bytes) {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

function b64decode(str) {
  const bin = atob(str)
  const out = new Uint8ClampedArray(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function saveProject() {
  const json = JSON.stringify({
    app: 'PixelForge',
    version: 1,
    width: state.w,
    height: state.h,
    data: b64encode(state.pixels)
  })
  const res = await window.api.saveProject(json, state.fileName)
  if (res && res.ok) {
    if (res.baseName) {
      state.fileName = res.baseName
      updateInfo()
    }
    toast('Проект сохранён')
  } else if (res && res.error) {
    toast('Не удалось сохранить: ' + res.error)
  }
}

async function openProject() {
  const res = await window.api.openProject()
  if (!res || !res.ok) {
    if (res && res.error) toast('Не удалось открыть: ' + res.error)
    return
  }
  try {
    const obj = JSON.parse(res.content)
    const w = clampSize(obj.width)
    const h = clampSize(obj.height)
    const data = b64decode(String(obj.data || ''))
    if (data.length !== w * h * 4) throw new Error('Размер данных не совпадает с холстом')
    allocate(w, h, data)
    if (res.baseName) state.fileName = res.baseName
    updateInfo()
    toast('Проект открыт')
  } catch (err) {
    toast('Файл не похож на проект PixelForge')
  }
}

async function exportPng() {
  const mult = Number($('exportScale').value) || 1
  const out = document.createElement('canvas')
  out.width = state.w * mult
  out.height = state.h * mult
  const octx = out.getContext('2d')
  octx.imageSmoothingEnabled = false
  octx.drawImage(buf, 0, 0, out.width, out.height)

  const res = await window.api.savePng(out.toDataURL('image/png'), state.fileName)
  if (res && res.ok) {
    toast(`PNG ${out.width}x${out.height} сохранён`)
  } else if (res && res.error) {
    toast('Не удалось экспортировать: ' + res.error)
  }
}

/* ---------------- canvas actions ---------------- */

function clearCanvas() {
  pushHistory()
  state.pixels.fill(0)
  commit()
  toast('Холст очищен (Ctrl+Z вернёт)')
}

function flipHorizontal() {
  pushHistory()
  const { w, h } = state
  const src = new Uint8ClampedArray(state.pixels)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      const di = (y * w + (w - 1 - x)) * 4
      state.pixels[di] = src[si]
      state.pixels[di + 1] = src[si + 1]
      state.pixels[di + 2] = src[si + 2]
      state.pixels[di + 3] = src[si + 3]
    }
  }
  commit()
}

function flipVertical() {
  pushHistory()
  const { w, h } = state
  const src = new Uint8ClampedArray(state.pixels)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      const di = ((h - 1 - y) * w + x) * 4
      state.pixels[di] = src[si]
      state.pixels[di + 1] = src[si + 1]
      state.pixels[di + 2] = src[si + 2]
      state.pixels[di + 3] = src[si + 3]
    }
  }
  commit()
}

function toggleGrid() {
  state.grid = !state.grid
  $('gridBtn').textContent = state.grid ? 'Сетка: вкл' : 'Сетка: выкл'
  requestRender()
}

/* ---------------- modals ---------------- */

function openNewModal() {
  $('newWidth').value = state.w
  $('newHeight').value = state.h
  $('newModal').classList.remove('hidden')
  $('newWidth').focus()
  $('newWidth').select()
}

function closeNewModal() {
  $('newModal').classList.add('hidden')
}

function createNewCanvas() {
  const w = clampSize($('newWidth').value)
  const h = clampSize($('newHeight').value)
  closeNewModal()
  allocate(w, h)
}

/* ---------------- wiring ---------------- */

document.querySelectorAll('.tool').forEach((el) => {
  el.addEventListener('click', () => setTool(el.dataset.tool))
})

$('newBtn').addEventListener('click', openNewModal)
$('openBtn').addEventListener('click', openProject)
$('saveBtn').addEventListener('click', saveProject)
$('exportBtn').addEventListener('click', exportPng)
$('undoBtn')?.addEventListener('click', undo)
$('redoBtn')?.addEventListener('click', redo)
$('clearBtn').addEventListener('click', clearCanvas)
$('flipHBtn').addEventListener('click', flipHorizontal)
$('flipVBtn').addEventListener('click', flipVertical)
$('zoomInBtn').addEventListener('click', () => zoomStep(1))
$('zoomOutBtn').addEventListener('click', () => zoomStep(-1))
$('fitBtn').addEventListener('click', fitView)
$('gridBtn').addEventListener('click', toggleGrid)

$('newCancel').addEventListener('click', closeNewModal)
$('newCreate').addEventListener('click', createNewCanvas)
$('newModal').addEventListener('click', (e) => {
  if (e.target === $('newModal')) closeNewModal()
})
$('newWidth').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createNewCanvas()
})
$('newHeight').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createNewCanvas()
})

document.querySelectorAll('.preset').forEach((el) => {
  el.addEventListener('click', () => {
    $('newWidth').value = el.dataset.size
    $('newHeight').value = el.dataset.size
  })
})

$('helpBtn').addEventListener('click', () => $('helpModal').classList.remove('hidden'))
$('helpClose').addEventListener('click', () => $('helpModal').classList.add('hidden'))
$('helpModal').addEventListener('click', (e) => {
  if (e.target === $('helpModal')) $('helpModal').classList.add('hidden')
})

window.addEventListener('keydown', (e) => {
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape') t.blur()
    return
  }

  if (e.code === 'Space') {
    spaceDown = true
    workspace.classList.add('pan-ready')
    e.preventDefault()
    return
  }

  const mod = e.ctrlKey || e.metaKey

  if (mod) {
    if (e.code === 'KeyZ') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (e.code === 'KeyY') {
      e.preventDefault()
      redo()
    } else if (e.code === 'KeyS') {
      e.preventDefault()
      saveProject()
    } else if (e.code === 'KeyO') {
      e.preventDefault()
      openProject()
    } else if (e.code === 'KeyE') {
      e.preventDefault()
      exportPng()
    } else if (e.code === 'KeyN') {
      e.preventDefault()
      openNewModal()
    } else if (e.code === 'KeyG') {
      e.preventDefault()
      toggleGrid()
    }
    return
  }

  switch (e.code) {
    case 'KeyB':
      setTool('pencil')
      break
    case 'KeyE':
      setTool('eraser')
      break
    case 'KeyG':
      setTool('fill')
      break
    case 'KeyI':
      setTool('picker')
      break
    case 'Equal':
    case 'NumpadAdd':
      zoomStep(1)
      break
    case 'Minus':
    case 'NumpadSubtract':
      zoomStep(-1)
      break
    case 'Digit0':
    case 'Numpad0':
      fitView()
      break
    case 'Escape':
      $('helpModal').classList.add('hidden')
      closeNewModal()
      break
  }
})

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false
    workspace.classList.remove('pan-ready')
  }
})

window.addEventListener('blur', () => {
  spaceDown = false
  workspace.classList.remove('pan-ready')
})

new ResizeObserver(() => requestRender()).observe(workspace)

/* ---------------- boot ---------------- */

buildPalette()
setColor(state.color, false)
allocate(32, 32)
updateInfo()
toast('Готово. Ctrl+Z — отмена, пробел — панорама')
