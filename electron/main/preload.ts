/**
 * Preload — contextBridge (AD-1). Seule surface exposée au renderer :
 * `window.api.*` (canaux IPC en whitelist, aucun accès Node/DB direct).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AppInfo, DbStatus, WindowApi } from '../../shared/types';

const api: WindowApi = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  dbStatus: (): Promise<DbStatus> => ipcRenderer.invoke('db:status'),
};

contextBridge.exposeInMainWorld('api', api);
