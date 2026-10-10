/** Узкий мост между окном и главным процессом. Окно не получает доступа к Node.js. */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ElabApi } from '../shared/api';

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: ElabApi = {
  app: {
    info: () => call(IPC.appInfo),
    setDirty: (dirty) => call(IPC.setDirty, dirty),
    closeConfirmed: () => call(IPC.closeConfirmed),
    onCloseRequest: (cb) => {
      const listener = (_e: unknown, choice: 'save' | 'discard') => cb(choice);
      ipcRenderer.on(IPC.closeRequest, listener);
      return () => { ipcRenderer.removeListener(IPC.closeRequest, listener); };
    },
  },
  projects: {
    list: () => call(IPC.list),
    create: (name) => call(IPC.create, name),
    open: (id) => call(IPC.open, id),
    save: (doc) => call(IPC.save, doc),
    autosave: (doc) => call(IPC.autosave, doc),
    discardRecovery: (id) => call(IPC.discardRecovery, id),
    rename: (id, name) => call(IPC.rename, id, name),
    duplicate: (id, name) => call(IPC.duplicate, id, name),
    saveAs: (doc, name) => call(IPC.saveAs, doc, name),
    remove: (id) => call(IPC.remove, id),
  },
  checkpoints: {
    list: (projectId) => call(IPC.cpList, projectId),
    create: (doc, label) => call(IPC.cpCreate, doc, label),
    restore: (current, checkpointId) => call(IPC.cpRestore, current, checkpointId),
  },
  sim: {
    run: (doc, opts) => call(IPC.simRun, doc, opts),
  },
  files: {
    exportProject: (doc) => call(IPC.exportProject, doc),
    importProject: () => call(IPC.importProject),
    resolveImport: (token, mode) => call(IPC.resolveImport, token, mode),
    backupAll: () => call(IPC.backupAll),
    restoreBackup: () => call(IPC.restoreBackup),
    saveSvg: (name, svg) => call(IPC.saveSvg, name, svg),
  },
};

contextBridge.exposeInMainWorld('elab', api);
