/**
 * Preload — contextBridge (AD-1). Seule surface exposée au renderer :
 * `window.api.*` (canaux IPC en whitelist, aucun accès Node/DB direct).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApiResult,
  AppContext,
  AppInfo,
  AppUser,
  AuditEntry,
  DbStatus,
  Module,
  ModuleInput,
  Room,
  RoomInput,
  WindowApi,
} from '../../shared/types';

const api: WindowApi = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  dbStatus: (): Promise<DbStatus> => ipcRenderer.invoke('db:status'),
  appContext: (): Promise<ApiResult<AppContext>> =>
    ipcRenderer.invoke('app:context'),
  rooms: {
    list: (): Promise<ApiResult<Room[]>> => ipcRenderer.invoke('rooms:list'),
    create: (input: RoomInput): Promise<ApiResult<Room>> =>
      ipcRenderer.invoke('rooms:create', input),
    update: (id: number, input: RoomInput): Promise<ApiResult<Room>> =>
      ipcRenderer.invoke('rooms:update', id, input),
    remove: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('rooms:remove', id),
    setActive: (id: number, active: boolean): Promise<ApiResult<Room>> =>
      ipcRenderer.invoke('rooms:setActive', id, active),
  },
  modules: {
    list: (): Promise<ApiResult<Module[]>> => ipcRenderer.invoke('modules:list'),
    create: (input: ModuleInput): Promise<ApiResult<Module>> =>
      ipcRenderer.invoke('modules:create', input),
    update: (id: number, input: ModuleInput): Promise<ApiResult<Module>> =>
      ipcRenderer.invoke('modules:update', id, input),
    remove: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('modules:remove', id),
  },
  profile: {
    list: (): Promise<ApiResult<AppUser[]>> => ipcRenderer.invoke('profile:list'),
    current: (): Promise<ApiResult<AppUser | null>> =>
      ipcRenderer.invoke('profile:current'),
    set: (id: number): Promise<ApiResult<AppUser>> =>
      ipcRenderer.invoke('profile:set', id),
  },
  audit: {
    list: (limit?: number): Promise<ApiResult<AuditEntry[]>> =>
      ipcRenderer.invoke('audit:list', limit),
  },
};

contextBridge.exposeInMainWorld('api', api);
