/**
 * Playlist Bracket – Windows desktop shell (Electron)
 * Starts the local Express API + static UI, opens a native window.
 */
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

// Desktop app uses a dedicated port so it won't clash with `npm run dev` (3001/5173)
const DEFAULT_PORT = 3847;

let mainWindow = null;
let httpServer = null;

function resolveEnvFiles() {
  const candidates = [];
  // Next to the installed .exe (best place for a personal YOUTUBE_API_KEY)
  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), '.env'));
  }
  // electron-builder extraResources
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, '.env'));
  }
  // Project root (dev) / app.asar parent
  candidates.push(path.join(app.getAppPath(), '.env'));
  candidates.push(path.join(app.getAppPath(), '..', '.env'));
  // Dev: repo root
  candidates.push(path.join(__dirname, '..', '.env'));
  return candidates;
}

function loadEnv() {
  try {
    const dotenv = require('dotenv');
    for (const file of resolveEnvFiles()) {
      if (fs.existsSync(file)) {
        dotenv.config({ path: file, override: false });
        console.log('[desktop] loaded env:', file);
      }
    }
  } catch (err) {
    console.warn('[desktop] dotenv load skipped:', err.message);
  }
}

function getPort() {
  const n = Number(process.env.PORT);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_PORT;
}

async function startBackend() {
  process.env.PLAYLIST_BRACKET_MANAGED = '1';
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.HOST = process.env.HOST || '127.0.0.1';

  const port = getPort();
  process.env.PORT = String(port);

  // When packaged, app path is the asar (or unpacked app dir)
  const appPath = app.getAppPath();
  const serverEntry = path.join(appPath, 'server', 'index.js');

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Server entry not found:\n${serverEntry}`);
  }

  const mod = await import(pathToFileURL(serverEntry).href);
  if (typeof mod.startServer !== 'function') {
    throw new Error('server/index.js did not export startServer()');
  }

  const { server, host } = await mod.startServer({ port, host: '127.0.0.1' });
  httpServer = server;

  await waitForHealth(port);
  return { port, host: host || '127.0.0.1' };
}

function waitForHealth(port, attempts = 40) {
  return new Promise((resolve, reject) => {
    let left = attempts;
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(400, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      left -= 1;
      if (left <= 0) {
        reject(new Error('Local server did not become healthy in time.'));
        return;
      }
      setTimeout(tryOnce, 150);
    };
    tryOnce();
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Playlist Bracket',
    backgroundColor: '#0b0a12',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links (Spotify, YouTube account, etc.) open in the real browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

async function boot() {
  loadEnv();

  try {
    const { port } = await startBackend();
    await createWindow(port);
  } catch (err) {
    console.error('[desktop] boot failed:', err);
    dialog.showErrorBox(
      'Playlist Bracket failed to start',
      String(err && err.message ? err.message : err)
    );
    app.quit();
  }
}

function shutdown() {
  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      /* ignore */
    }
    httpServer = null;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    shutdown();
    app.quit();
  });

  app.on('before-quit', shutdown);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
}
