// Упрощённые объявления Electron (официальный electron.d.ts поставляется npm-пакетом, недоступным здесь).
declare module 'electron' {
  export const app: any;
  export const dialog: any;
  export const ipcMain: any;
  export const ipcRenderer: any;
  export const contextBridge: any;
  export const Menu: any;
  export const session: any;
  export class BrowserWindow { constructor(opts?: any); [k: string]: any }
  export type ElectronApplication = any;
}
