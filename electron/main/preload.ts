/**
 * Preload — contextBridge (AD-1). Seule surface exposée au renderer :
 * `window.api.*` (canaux IPC en whitelist, aucun accès Node/DB direct).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AbsenceDecisionInput,
  AbsenceDetail,
  AbsenceInput,
  AbsenceListRow,
  AbsenceRow,
  AttendanceCountsInput,
  AttendanceDetail,
  AnnualFilter,
  AnnualRow,
  ApiResult,
  AppContext,
  AppInfo,
  AppUser,
  AuditEntry,
  AvailabilityInput,
  AvailabilityRow,
  BackupRow,
  CalendarExceptionInput,
  CalendarExceptionRow,
  ConflictFilter,
  ConflictItem,
  ConflictSummary,
  ContextSemesters,
  DbStatus,
  DeleteResult,
  GenerateParams,
  GenerationApplyResult,
  GenerationCatalog,
  GenerationDetail,
  GenerationListFilter,
  GenerationResult,
  GenerationRow,
  ExportEntityType,
  GroupInput,
  ImpactedSession,
  ImportApplyResult,
  ImportEntityType,
  ImportPreview,
  ImportStrategy,
  MasterDetail,
  MasterInput,
  MasterListFilter,
  MasterModuleInput,
  MasterModuleRow,
  MasterRow,
  MasterStatus,
  Module,
  ModuleInput,
  MonthFilter,
  NominativeItem,
  OccupancyFilter,
  OccupancyRow,
  PlacementConflict,
  PlacementQuery,
  ProfessorDetail,
  ProfessorInput,
  ProfessorRow,
  RegistryFilter,
  RegistryPage,
  RegistryResult,
  RemainingResult,
  Report,
  ReportExportFile,
  ReportFilter,
  ReportId,
  ReportPdfInput,
  Room,
  RoomInput,
  RoomReassignPreview,
  RoomReassignResult,
  SessionCreateInput,
  SessionDetail,
  SessionEditResult,
  SessionMoveInput,
  SessionRow,
  SessionStatusInput,
  StudentGroupRow,
  StudentInput,
  StudentRow,
  TimeSlotInput,
  TimeSlotRow,
  WeekFilter,
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
  timetable: {
    week: (filter: WeekFilter): Promise<ApiResult<SessionRow[]>> =>
      ipcRenderer.invoke('timetable:week', filter),
    month: (filter: MonthFilter): Promise<ApiResult<SessionRow[]>> =>
      ipcRenderer.invoke('timetable:month', filter),
    annual: (filter: AnnualFilter): Promise<ApiResult<AnnualRow[]>> =>
      ipcRenderer.invoke('timetable:annual', filter),
    conflicts: (
      filter?: ConflictFilter,
    ): Promise<ApiResult<ConflictItem[]>> =>
      ipcRenderer.invoke('timetable:conflicts', filter),
    summary: (): Promise<ApiResult<ConflictSummary>> =>
      ipcRenderer.invoke('timetable:summary'),
    occupancy: (filter: OccupancyFilter): Promise<ApiResult<OccupancyRow[]>> =>
      ipcRenderer.invoke('timetable:occupancy', filter),
  },
  // P16 — résolution assistée des conflits de salle.
  conflicts: {
    reassignPreview: (): Promise<ApiResult<RoomReassignPreview>> =>
      ipcRenderer.invoke('conflicts:reassignPreview'),
    reassignApply: (): Promise<ApiResult<RoomReassignResult>> =>
      ipcRenderer.invoke('conflicts:reassignApply'),
  },
  sessions: {
    get: (id: number): Promise<ApiResult<SessionDetail>> =>
      ipcRenderer.invoke('sessions:get', id),
    checkPlacement: (
      query: PlacementQuery,
    ): Promise<ApiResult<PlacementConflict[]>> =>
      ipcRenderer.invoke('sessions:checkPlacement', query),
    create: (input: SessionCreateInput): Promise<SessionEditResult> =>
      ipcRenderer.invoke('sessions:create', input),
    move: (
      id: number,
      input: SessionMoveInput,
    ): Promise<SessionEditResult> =>
      ipcRenderer.invoke('sessions:move', id, input),
    setStatus: (
      id: number,
      input: SessionStatusInput,
    ): Promise<SessionEditResult> =>
      ipcRenderer.invoke('sessions:setStatus', id, input),
    setGroups: (
      id: number,
      groupIds: number[],
    ): Promise<SessionEditResult> =>
      ipcRenderer.invoke('sessions:setGroups', id, groupIds),
    remove: (id: number): Promise<SessionEditResult> =>
      ipcRenderer.invoke('sessions:remove', id),
    attendanceSheet: (id: number): Promise<ApiResult<ReportExportFile>> =>
      ipcRenderer.invoke('sessions:attendanceSheet', id),
  },
  registry: {
    list: (
      filter?: RegistryFilter,
      page?: RegistryPage,
    ): Promise<ApiResult<RegistryResult>> =>
      ipcRenderer.invoke('registry:list', filter, page),
    remaining: (
      masterModuleId: number,
    ): Promise<ApiResult<RemainingResult>> =>
      ipcRenderer.invoke('registry:remaining', masterModuleId),
  },
  absences: {
    list: (professorId?: number): Promise<ApiResult<AbsenceListRow[]>> =>
      ipcRenderer.invoke('absences:list', professorId),
    get: (id: number): Promise<ApiResult<AbsenceDetail>> =>
      ipcRenderer.invoke('absences:get', id),
    decide: (
      absenceId: number,
      sessionId: number,
      input: AbsenceDecisionInput,
    ): Promise<SessionEditResult> =>
      ipcRenderer.invoke('absences:decide', absenceId, sessionId, input),
  },
  attendance: {
    get: (sessionId: number): Promise<ApiResult<AttendanceDetail>> =>
      ipcRenderer.invoke('attendance:get', sessionId),
    setCounts: (
      sessionId: number,
      input: AttendanceCountsInput,
    ): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('attendance:setCounts', sessionId, input),
    setNominative: (
      sessionId: number,
      items: NominativeItem[],
    ): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('attendance:setNominative', sessionId, items),
    clear: (sessionId: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('attendance:clear', sessionId),
  },
  students: {
    list: (groupId: number): Promise<ApiResult<StudentRow[]>> =>
      ipcRenderer.invoke('students:list', groupId),
    add: (
      groupId: number,
      input: StudentInput,
    ): Promise<ApiResult<StudentRow>> =>
      ipcRenderer.invoke('students:add', groupId, input),
    remove: (id: number): Promise<DeleteResult> =>
      ipcRenderer.invoke('students:remove', id),
  },
  generation: {
    run: (params: GenerateParams): Promise<ApiResult<GenerationResult>> =>
      ipcRenderer.invoke('generation:run', params),
    list: (
      filter?: GenerationListFilter,
    ): Promise<ApiResult<GenerationRow[]>> =>
      ipcRenderer.invoke('generation:list', filter),
    get: (id: number): Promise<ApiResult<GenerationDetail>> =>
      ipcRenderer.invoke('generation:get', id),
    apply: (id: number): Promise<GenerationApplyResult> =>
      ipcRenderer.invoke('generation:apply', id),
    abandon: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('generation:abandon', id),
    catalog: (
      semesterId: number,
    ): Promise<ApiResult<GenerationCatalog>> =>
      ipcRenderer.invoke('generation:catalog', semesterId),
  },
  reports: {
    run: (
      id: ReportId,
      filter?: ReportFilter,
    ): Promise<ApiResult<Report>> =>
      ipcRenderer.invoke('reports:run', id, filter),
    exportCsv: (report: Report): Promise<ApiResult<ReportExportFile>> =>
      ipcRenderer.invoke('reports:exportCsv', report),
    exportPdf: (
      input: ReportPdfInput,
    ): Promise<ApiResult<ReportExportFile>> =>
      ipcRenderer.invoke('reports:exportPdf', input),
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
  importExport: {
    preview: (
      type: ImportEntityType,
      csvText: string,
    ): Promise<ApiResult<ImportPreview>> =>
      ipcRenderer.invoke('import:preview', type, csvText),
    apply: (
      type: ImportEntityType,
      csvText: string,
      strategy: ImportStrategy,
    ): Promise<ApiResult<ImportApplyResult>> =>
      ipcRenderer.invoke('import:apply', type, csvText, strategy),
    template: (
      type: ImportEntityType,
    ): Promise<ApiResult<ReportExportFile>> =>
      ipcRenderer.invoke('import:template', type),
    exportEntity: (
      type: ExportEntityType,
    ): Promise<ApiResult<ReportExportFile>> =>
      ipcRenderer.invoke('export:entity', type),
  },
  settings: {
    slots: {
      list: (): Promise<ApiResult<TimeSlotRow[]>> =>
        ipcRenderer.invoke('settings:slots:list'),
      create: (input: TimeSlotInput): Promise<ApiResult<TimeSlotRow>> =>
        ipcRenderer.invoke('settings:slots:create', input),
      update: (
        id: number,
        input: TimeSlotInput,
      ): Promise<ApiResult<TimeSlotRow>> =>
        ipcRenderer.invoke('settings:slots:update', id, input),
      remove: (id: number): Promise<ApiResult<null>> =>
        ipcRenderer.invoke('settings:slots:delete', id),
    },
    exceptions: {
      list: (): Promise<ApiResult<CalendarExceptionRow[]>> =>
        ipcRenderer.invoke('settings:exceptions:list'),
      create: (
        input: CalendarExceptionInput,
      ): Promise<ApiResult<CalendarExceptionRow>> =>
        ipcRenderer.invoke('settings:exceptions:create', input),
      update: (
        id: number,
        input: CalendarExceptionInput,
      ): Promise<ApiResult<CalendarExceptionRow>> =>
        ipcRenderer.invoke('settings:exceptions:update', id, input),
      remove: (id: number): Promise<ApiResult<null>> =>
        ipcRenderer.invoke('settings:exceptions:delete', id),
    },
    retention: {
      get: (): Promise<ApiResult<number>> =>
        ipcRenderer.invoke('settings:retention:get'),
      set: (n: number): Promise<ApiResult<number>> =>
        ipcRenderer.invoke('settings:retention:set', n),
    },
  },
  backups: {
    list: (): Promise<ApiResult<BackupRow[]>> =>
      ipcRenderer.invoke('backups:list'),
    create: (): Promise<ApiResult<BackupRow>> =>
      ipcRenderer.invoke('backups:create'),
    restore: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('backups:restore', { id }),
    remove: (id: number): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('backups:delete', id),
    openFolder: (): Promise<ApiResult<null>> =>
      ipcRenderer.invoke('backups:openFolder'),
  },
};

contextBridge.exposeInMainWorld('api', api);
