import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { ServerClient } from './server-client'
import * as logger from './logger'

let mainWindow: BrowserWindow | null = null
let client: ServerClient | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // Load the renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC(): void {
  ipcMain.handle('pty:create', async (_event, options?: Record<string, unknown>) => {
    const session = await client!.create(options as any)
    // Auto-attach so we receive data events for this session
    await client!.attach(session.sessionId)
    return session
  })

  ipcMain.handle('pty:list', async () => {
    return client!.list()
  })

  ipcMain.handle('pty:attach', async (_event, sessionId: string) => {
    return client!.attach(sessionId)
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    client!.write(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    client!.resize(sessionId, cols, rows)
  })

  ipcMain.on('log', (_event, message: string) => {
    logger.log(message)
  })

  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
      shell.openExternal(url)
    }
  })

  ipcMain.handle('pty:destroy', async (_event, sessionId: string) => {
    await client!.destroy(sessionId)
  })

  ipcMain.handle('server:status', () => {
    return client!.isConnected()
  })
}

function wireClientEvents(): void {
  client!.on('data', (sessionId: string, data: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:data:${sessionId}`, data)
    }
  })

  client!.on('exit', (sessionId: string, exitCode: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:exit:${sessionId}`, exitCode)
    }
  })

  client!.on('connect', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:status', true)
    }
  })

  client!.on('disconnect', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:status', false)
    }
  })
}

app.setName('Spaceterm')

app.whenReady().then(async () => {
  logger.init()
  logger.log('Electron app starting')

  client = new ServerClient()
  setupIPC()
  wireClientEvents()

  try {
    await client.connect()
    logger.log('Server connection established')
  } catch {
    logger.log('Server connection failed')
    console.error('Failed to connect to terminal server. Is it running? (npm run server)')
    // Will auto-reconnect, so proceed with creating window
  }

  createWindow()
  mainWindow!.setFullScreen(true)
  logger.log('Window created')
})

app.on('window-all-closed', () => {
  // Don't destroy sessions — they persist on the server
  client?.disconnect()
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
