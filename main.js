const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#111318',
    title: 'PixelForge',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
}

function baseNameOf(filePath) {
  return path.basename(filePath).replace(/\.(json|png)$/i, '')
}

ipcMain.handle('png:save', async (_event, payload) => {
  try {
    const dataUrl = String(payload?.dataUrl || '')
    const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl)
    if (!match) return { ok: false, error: 'Некорректные данные изображения' }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт PNG',
      defaultPath: `${payload?.name || 'pixel-art'}.png`,
      filters: [{ name: 'PNG изображение', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }

    await fs.writeFile(result.filePath, Buffer.from(match[1], 'base64'))
    return { ok: true, filePath: result.filePath, baseName: baseNameOf(result.filePath) }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
})

ipcMain.handle('project:save', async (_event, payload) => {
  try {
    const json = String(payload?.json || '')
    if (!json) return { ok: false, error: 'Пустой проект' }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить проект',
      defaultPath: `${payload?.name || 'pixel-art'}.json`,
      filters: [{ name: 'Проект PixelForge', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }

    await fs.writeFile(result.filePath, json, 'utf8')
    return { ok: true, filePath: result.filePath, baseName: baseNameOf(result.filePath) }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
})

ipcMain.handle('project:open', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Открыть проект',
      properties: ['openFile'],
      filters: [{ name: 'Проект PixelForge', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true }

    const filePath = result.filePaths[0]
    const content = await fs.readFile(filePath, 'utf8')
    return { ok: true, content, filePath, baseName: baseNameOf(filePath) }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
})

app.whenReady().then(() => {
  app.setAppUserModelId('com.multitool.pixelforge')
  Menu.setApplicationMenu(null)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
