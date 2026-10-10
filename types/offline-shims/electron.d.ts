// Упрощённые объявления Electron (официальный electron.d.ts поставляется npm-пакетом, недоступным здесь).
declare module 'electron' {
  export const app: any;
  export const dialog: any;
  export const ipcMain: any;
  export const ipcRenderer: any;
  export const contextBridge: any;
  export const Menu: any;
  export const session: any;
  export const screen: any;
  export class BrowserWindow { constructor(opts?: any); static getAllWindows(): BrowserWindow[]; [k: string]: any }
  export type ElectronApplication = any;
}
