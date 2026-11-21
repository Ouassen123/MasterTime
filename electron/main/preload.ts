/**
 * Preload — contextBridge (AD-1). Seule surface exposée au renderer :
 * `window.api.*` (canaux IPC en whitelist, aucun accès Node/DB direct).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AbsenceInput,
  AbsenceRow,
  ApiResult,
  AppContext,
  AppInfo,
  AppUser,
  AuditEntry,
  AvailabilityInput,
  AvailabilityRow,
  ContextSemesters,
  DbStatus,
  DeleteResult,
  GroupInput,
  ImpactedSession,
  MasterDetail,
  MasterInput,
  MasterListFilter,
  MasterModuleInput,
  MasterModuleRow,
  MasterRow,
  MasterStatus,
  Module,
  ModuleInput,
  ProfessorDetail,
  ProfessorInput,
  ProfessorRow,
  Room,
  RoomInput,
  StudentGroupRow,
  WindowApi,
} from '../../shared/types';

const api: WindowApi = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  dbStatus: (): Promise<DbStatus> => ipcRenderer.invoke('db:status'),
  appContext: (): Promise<ApiResult<AppContext>> =>
    ipcRenderer.invoke('app:context'),
  contextSemesters: (): Promise<ApiResult<ContextSemesters>> =>
    ipcRenderer.invoke('context:semesters'),
  masters: {
    list: (filter?: MasterListFilter): Promise<ApiResult<MasterRow[]>> =>
      ipcRenderer.invoke('masters:list', filter),
    get: (id: number): Promise<ApiResult<MasterDetail>> =>
      ipcRenderer.invoke('masters:get', id),
    create: (input: MasterInput): Promise<ApiResult<MasterRow>> =>
      ipcRenderer.invoke('masters:create', input),
    update: (id: number, input: MasterInput): Promise<ApiResult<MasterRow>> =>
      ipcRenderer.invoke('masters:update', id, input),
    setStatus: (
      id: number,
      status: MasterStatus,
    ): Promise<ApiResult<MasterRow>> =>
      ipcRenderer.invoke('masters:setStatus', id, status),
    remove: (id: number): Promise<DeleteResult> =>
      ipcRenderer.invoke('masters:remove', id),
    addGroup: (
      masterId: number,
      input: GroupInput,
    ): Promise<ApiResult<StudentGroupRow>> =>
      ipcRenderer.invoke('masters:addGroup', masterId, input),
    renameGroup: (
      id: number,
      input: GroupInput,
    ): Promise<ApiResult<StudentGroupRow>> =>
      ipcRenderer.invoke('masters:renameGroup', id, input),
    removeGroup: (id: number): Promise<DeleteResult> =>
      ipcRenderer.invoke('masters:removeGroup', id),
    attachModule: (
      masterId: number,
      input: MasterModuleInput,
    ): Promise<ApiResult<MasterModuleRow>> =>
      ipcRenderer.invoke('masters:attachModule', masterId, input),
    updateModule: (
      id: number,
      input: MasterModuleInput,
    ): Promise<ApiResult<MasterModuleRow>> =>
      ipcRenderer.invoke('masters:updateModule', id, input),
    detachModule: (id: number): Promise<DeleteResult> =>
      ipcRenderer.invoke('masters:detachModule', id),
  },
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
  professors: {
    list: (search?: string): Promise<ApiResult<ProfessorRow[]>> =>
      ipcRenderer.invoke('professors:list', search),
    get: (id: number): Promise<ApiResult<ProfessorDetail>> =>
      ipcRenderer.invoke('professors:get', id),
    create: (input: ProfessorInput): Promise<ApiResult<ProfessorRow>> =>
      ipcRenderer.invoke('professors:create', input),
    update: (
      id: number,
      input: ProfessorInput,
    ): Promise<ApiResult<ProfessorRow>> =>
      ipcRenderer.invoke('professors:update', id, input),
    remove: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('professors:remove', id),
    setActive: (id: number, active: boolean): Promise<ApiResult<ProfessorRow>> =>
      ipcRenderer.invoke('professors:setActive', id, active),
    availability: {
      list: (professorId: number): Promise<ApiResult<AvailabilityRow[]>> =>
        ipcRenderer.invoke('professors:availability:list', professorId),
      add: (
        professorId: number,
        input: AvailabilityInput,
      ): Promise<ApiResult<AvailabilityRow>> =>
        ipcRenderer.invoke('professors:availability:add', professorId, input),
      remove: (id: number): Promise<ApiResult<null>> =>
        ipcRenderer.invoke('professors:availability:remove', id),
    },
    absence: {
      list: (professorId: number): Promise<ApiResult<AbsenceRow[]>> =>
        ipcRenderer.invoke('professors:absence:list', professorId),
      add: (
        professorId: number,
        input: AbsenceInput,
      ): Promise<ApiResult<{ absence: AbsenceRow; impacted: ImpactedSession[] }>> =>
        ipcRenderer.invoke('professors:absence:add', professorId, input),
      remove: (id: number): Promise<ApiResult<null>> =>
        ipcRenderer.invoke('professors:absence:remove', id),
    },
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
