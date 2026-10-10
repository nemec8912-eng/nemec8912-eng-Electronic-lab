/** Точка входа главного процесса Electron. */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { APP_NAME } from '../core/appinfo';
import { AppError } from '../core/result';
import { IPC } from '../shared/api';
import { DataStore } from '../storage/store';
import { registerIpc } from './ipc';
import { resolveDataRoot } from './paths';

app.setName(APP_NAME);

let mainWindow: BrowserWindow | null = null;
let store: DataStore | null = null;
let dirty = false;
let allowClose = false;

const choice = resolveDataRoot({
  envDataDir: process.env.ELAB_DATA_DIR,
  exePath: app.getPath('exe'),
  userDataPath: app.getPath('userData'),
  exists: existsSync,
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox(APP_NAME, `Не удалось запустить программу:\n${(e as Error).message}`);
    app.exit(1);
  });
}

async function start() {
  Menu.setApplicationMenu(null);
  // Никаких сетевых запросов из окна: разрешены только локальные файлы приложения.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const allowed = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:');
    cb({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  try {
    store = await DataStore.open(choice.root);
  } catch (e) {
    const msg = e instanceof AppError ? e.message : `Не удалось открыть папку данных ${choice.root}:\n${(e as Error).message}`;
    dialog.showErrorBox(APP_NAME, msg);
    app.exit(1);
    return;
  }

  registerIpc({
    getStore: () => {
      if (!store) throw new AppError('no-store', 'Хранилище не открыто');
      return store;
    },
    reopenStore: async () => {
      const root = store!.root;
      await store!.close();
      store = await DataStore.open(root);
    },
    getWindow: () => mainWindow,
    portable: choice.portable,
    setDirty: (d) => { dirty = d; },
    confirmClose: () => {
      allowClose = true;
      mainWindow?.close();
    },
  });

  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: APP_NAME,
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', async (e) => {
    if (allowClose || !dirty) return;
    e.preventDefault();
    const r = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      title: APP_NAME,
      message: 'В проекте есть несохранённые изменения.',
      detail: 'Сохранить их перед выходом?',
      buttons: ['Сохранить', 'Не сохранять', 'Отмена'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (r.response === 2) return;
    mainWindow?.webContents.send(IPC.closeRequest, r.response === 0 ? 'save' : 'discard');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('window-all-closed', async () => {
  try {
    await store?.close();
  } finally {
    app.quit();
  }
});
