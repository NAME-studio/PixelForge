'use strict'

const fs = require('node:fs')
const path = require('node:path')

const GRID = 16
const SIZES = [16, 32, 48, 64, 128, 256]

const BG = [0x15, 0x1a, 0x24, 255]
const BORDER = [0x23, 0x2a, 0x38, 255]
const MAIN = [0xff, 0x4d, 0x6d, 255]
const LIGHT = [0xff, 0x8f, 0xa3, 255]
const DARK = [0xc9, 0x18, 0x4a, 255]

const HEART = [
  '.##..##.',
  '########',
  '########',
  '########',
  '.######.',
  '..####..',
  '...##...'
]

const grid = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => BG.slice()))

for (let i = 0; i < GRID; i++) {
  grid[0][i] = BORDER.slice()
  grid[GRID - 1][i] = BORDER.slice()
  grid[i][0] = BORDER.slice()
  grid[i][GRID - 1] = BORDER.slice()
}

const ox = 4
const oy = 5

HEART.forEach((row, y) => {
  for (let x = 0; x < row.length; x++) {
    if (row[x] === '#') grid[oy + y][ox + x] = MAIN.slice()
  }
})

;[
  [5, 5],
  [5, 6],
  [6, 4],
  [6, 5],
  [7, 4]
].forEach(([y, x]) => {
  grid[y][x] = LIGHT.slice()
})

;[
  [9, 8],
  [9, 9],
  [10, 6],
  [10, 7],
  [10, 8],
  [10, 9],
  [11, 7],
  [11, 8]
].forEach(([y, x]) => {
  grid[y][x] = DARK.slice()
})

function pixelAt(x, y, size) {
  const cell = size / GRID
  const gx = Math.min(GRID - 1, Math.floor(x / cell))
  const gy = Math.min(GRID - 1, Math.floor(y / cell))
  return grid[gy][gx]
}

function buildDib(size) {
  const xorSize = size * size * 4
  const maskRowBytes = Math.ceil(size / 32) * 4
  const maskSize = maskRowBytes * size
  const buf = Buffer.alloc(40 + xorSize + maskSize)

  buf.writeUInt32LE(40, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8)
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(xorSize + maskSize, 20)

  let offset = 40
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y, size)
      buf[offset++] = b
      buf[offset++] = g
      buf[offset++] = r
      buf[offset++] = a
    }
  }

  const maskStart = 40 + xorSize
  for (let y = 0; y < size; y++) {
    const rowStart = maskStart + y * maskRowBytes
    for (let x = 0; x < size; x++) {
      const alpha = pixelAt(x, size - 1 - y, size)[3]
      if (alpha === 0) {
        buf[rowStart + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }

  return buf
}

function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, data: buildDib(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length

  images.forEach((img, i) => {
    const e = i * 16
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e)
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1)
    entries.writeUInt8(0, e + 2)
    entries.writeUInt8(0, e + 3)
    entries.writeUInt16LE(1, e + 4)
    entries.writeUInt16LE(32, e + 6)
    entries.writeUInt32LE(img.data.length, e + 8)
    entries.writeUInt32LE(offset, e + 12)
    offset += img.data.length
  })

  return Buffer.concat([header, entries, ...images.map((img) => img.data)])
}

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'icon.ico')
fs.writeFileSync(outFile, buildIco(SIZES))
console.log('icon written:', outFile, fs.statSync(outFile).size, 'bytes')
