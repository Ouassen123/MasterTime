/**
 * TimetablePage (P7a) — emplois du temps en lecture seule : vues Semaine
 * (tous Masters), par Master / Professeur / Salle, Mois et Année, avec
 * statuts colorés (palette DESIGN.md), blocages Licence (gris) dans la
 * vue Salle, drawer de détail séance et panneau de conflits persistant
 * (volet droit collapsible — jamais de toast pour les conflits).
 *
 * Grille hebdo à positionnement absolu : axe vertical 07:00→20:00
 * (780 min, 1px/min), colonnes Lun→Dim. Les séances qui se chevauchent
 * sont réparties en « voies » côte à côte dans la colonne.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Calendar,
  Card,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  TimePicker,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  AcademicYearRef,
  AnnualRow,
  ConflictItem,
  ConflictKind,
  EffectiveSessionStatus,
  MasterDetail,
  MasterRow,
  Module,
  OccupancyRow,
  PlacementConflict,
  ProfessorRow,
  Room,
  SessionDetail,
  SessionEditResult,
  SessionRow,
  SessionStatus,
  SessionStatusInput,
  StudentGroupRow,
} from '../../shared/types';
import { EFFECTIVE_SESSION_STATUSES } from '../../shared/types';

const { Text, Title } = Typography;

// Palette statuts — DESIGN.md (un statut = une couleur, partout).
const STATUS_COLORS: Record<EffectiveSessionStatus, string> = {
  PREVUE: '#2563EB',
  REALISEE: '#16A34A',
  NON_ENCORE_REALISEE: '#D97706',
  ANNULEE: '#9CA3AF',
  REPORTEE: '#7C3AED',
};

const KIND_COLORS: Record<ConflictKind, string> = {
  ROOM: '#DC2626',
  PROFESSOR: '#D97706',
  MASTER: '#7C3AED',
  GROUP: '#0284C7',
  EXTERNAL: '#4B5563',
};

type Scope = 'week' | 'master' | 'professor' | 'room' | 'month' | 'year';

const DAY_START = 7 * 60; // 07:00
const DAY_END = 20 * 60; // 20:00 → axe 780 min
const HOURS = Array.from(
  { length: (DAY_END - DAY_START) / 60 + 1 },
  (_, i) => DAY_START + i * 60,
);

function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(
    min % 60,
  ).padStart(2, '0')}`;
}

/** Lundi (AD-7 : 0=lun) de la semaine contenant `d`. */
function mondayOf(d: Dayjs): Dayjs {
  return d.subtract((d.day() + 6) % 7, 'day');
}

interface Lane extends SessionRow {
  lane: number;
  lanes: number;
}

/**
 * Répartition en voies : les séances qui se chevauchent dans un même jour
 * partagent la largeur de la colonne (tri par début, plus long d'abord).
 */
function computeLanes(sessions: SessionRow[]): Lane[] {
  const sorted = [...sessions].sort(
    (a, b) => a.start_min - b.start_min || a.end_min - b.end_min,
  );
  const lanesEnd: number[] = [];
  const out = sorted.map((s): Lane => {
    let lane = lanesEnd.findIndex((end) => end <= s.start_min);
    if (lane === -1) {
      lane = lanesEnd.length;
      lanesEnd.push(s.end_min);
    } else {
      lanesEnd[lane] = s.end_min;
    }
    return { ...s, lane, lanes: 0 };
  });
  // lanes réel = taille du groupe de chevauchement (recalculé par cluster).
  for (const s of out) {
    const cluster = out.filter(
      (o) => o.start_min < s.end_min && s.start_min < o.end_min,
    );
    s.lanes = Math.max(...cluster.map((o) => o.lane)) + 1;
  }
  return out;
}

function SessionBlock(props: {
  session: Lane;
  highlight: boolean;
  highlightColor: string;
  onClick: () => void;
}): React.JSX.Element | null {
  const { session: s, highlight, highlightColor, onClick } = props;
  const { t } = useTranslation();
  const color = STATUS_COLORS[s.effective_status];
  // Clip à l'axe 07:00–20:00 (séance débordante ou hors axe).
  const startC = Math.max(s.start_min, DAY_START);
  const endC = Math.min(s.end_min, DAY_END);
  if (endC - startC <= 0) return null;
  const top = startC - DAY_START;
  const height = Math.max(18, endC - startC);
  const widthPct = 100 / s.lanes;
  return (
    <div
      role="button"
      tabIndex={0}
      className="tt-block"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      style={{
        position: 'absolute',
        top,
        height,
        left: `${s.lane * widthPct}%`,
        width: `calc(${widthPct}% - 2px)`,
        background: `${color}1F`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 4,
        padding: '2px 4px',
        overflow: 'hidden',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1.25,
        outline: highlight ? `2px solid ${highlightColor}` : 'none',
        zIndex: highlight ? 3 : 1,
      }}
    >
      <div style={{ fontWeight: 600, color: '#111827' }}>
        {minToHHMM(s.start_min)}–{minToHHMM(s.end_min)}
      </div>
      <div
        dir="auto"
        style={{
          color: '#111827',
          textDecoration:
            s.effective_status === 'ANNULEE' ? 'line-through' : 'none',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
        title={s.module.name}
      >
        {s.module.name}
      </div>
      <div dir="auto" style={{ color: '#4B5563' }}>
        {s.room.name} · {s.professor.full_name}
      </div>
      {s.lanes === 1 && height >= 50 && (
        <div dir="auto" style={{ color: '#4B5563' }}>
          {s.master.name}
          {s.group_name ? ` · ${s.group_name}` : ''}
        </div>
      )}
      {s.effective_status === 'REPORTEE' && (
        <Tag color={STATUS_COLORS.REPORTEE} style={{ marginTop: 2 }}>
          {t('timetable.block.reported')}
        </Tag>
      )}
    </div>
  );
}

function OccupancyBlock(props: { occ: OccupancyRow }): React.JSX.Element | null {
  const { occ } = props;
  const startC = Math.max(occ.start_min, DAY_START);
  const endC = Math.min(occ.end_min, DAY_END);
  if (endC - startC <= 0) return null;
  const top = startC - DAY_START;
  const height = Math.max(16, endC - startC);
  return (
    <Tooltip
      title={<span dir="auto">{`${occ.label} · ${occ.module ?? ''}`}</span>}
    >
      <div
        style={{
          position: 'absolute',
          top,
          height,
          left: 1,
          right: 1,
          background: '#4B55631F',
          borderLeft: '3px solid #4B5563',
          borderRadius: 4,
          padding: '2px 4px',
          overflow: 'hidden',
          fontSize: 11,
          lineHeight: 1.25,
          color: '#4B5563',
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {minToHHMM(occ.start_min)}–{minToHHMM(occ.end_min)}
        </div>
        <div dir="auto">{occ.label}</div>
      </div>
    </Tooltip>
  );
}

export function TimetablePage(): React.JSX.Element {
  const { t } = useTranslation();

  // --- Portée & navigation ----------------------------------------------------
  const [scope, setScope] = useState<Scope>('week');
  const [weekStart, setWeekStart] = useState<Dayjs>(() => mondayOf(dayjs()));
  const [entityId, setEntityId] = useState<number | undefined>(undefined);
  const [monthValue, setMonthValue] = useState<Dayjs>(() => dayjs());
  const [yearId, setYearId] = useState<number | undefined>(undefined);

  // --- Référentiels (Selects) -------------------------------------------------
  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [professors, setProfessors] = useState<ProfessorRow[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [years, setYears] = useState<AcademicYearRef[]>([]);

  // --- Données ----------------------------------------------------------------
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [occupancy, setOccupancy] = useState<OccupancyRow[]>([]);
  const [annual, setAnnual] = useState<AnnualRow[]>([]);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [conflictsOpen, setConflictsOpen] = useState(true);
  const [conflictIds, setConflictIds] = useState<Set<number>>(new Set());
  const [conflictKind, setConflictKind] = useState<ConflictKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Filtres ----------------------------------------------------------------
  const [statuses, setStatuses] = useState<EffectiveSessionStatus[]>([]);
  const [moduleId, setModuleId] = useState<number | undefined>(undefined);

  // --- Drawer séance ------------------------------------------------------------
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailReq = useRef(0);

  // --- Édition P7b (mutations + modals) -------------------------------------------
  // reloadKey : incrémenté après chaque mutation → recharge semaine/mois/année.
  const [reloadKey, setReloadKey] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<
    'REALISEE' | 'REPORTEE' | 'ANNULEE' | 'CORRECTIVE' | null
  >(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Refus BR-10 : Modal détaillée (jamais un simple toast).
  const [refusal, setRefusal] = useState<PlacementConflict[] | null>(null);
  // Référentiels des modals Groupes / Création (chargés à la demande).
  const [masterGroups, setMasterGroups] = useState<StudentGroupRow[]>([]);
  const [mmGroupId, setMmGroupId] = useState<number | null>(null);
  const [createDetail, setCreateDetail] = useState<MasterDetail | null>(null);
  const [editForm] = Form.useForm();
  const [statusForm] = Form.useForm();
  const [groupsForm] = Form.useForm();
  const [createForm] = Form.useForm();

  const weekStartIso = weekStart.format('YYYY-MM-DD');

  const entityFilter = useMemo(() => {
    switch (scope) {
      case 'master':
        return { masterId: entityId };
      case 'professor':
        return { professorId: entityId };
      case 'room':
        return { roomId: entityId };
      default:
        return {};
    }
  }, [scope, entityId]);

  const loadConflicts = useCallback(async (): Promise<void> => {
    if (!hasApi()) return;
    try {
      const res = await api().timetable.conflicts();
      if (res.ok) setConflicts(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      setError(t('db.unavailable'));
      return;
    }
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .masters.list()
      .then((r) => (r.ok ? setMasters(r.data) : notify(r)))
      .catch(notify);
    void api()
      .professors.list()
      .then((r) => (r.ok ? setProfessors(r.data) : notify(r)))
      .catch(notify);
    void api()
      .rooms.list()
      .then((r) => (r.ok ? setRooms(r.data) : notify(r)))
      .catch(notify);
    void api()
      .modules.list()
      .then((r) => (r.ok ? setModules(r.data) : notify(r)))
      .catch(notify);
    void api()
      .contextSemesters()
      .then((r) => {
        if (r.ok) {
          setYears(r.data.academicYears);
          const cur = r.data.academicYears.find((y) => y.is_current === 1);
          if (cur) setYearId(cur.id);
        } else notify(r);
      })
      .catch(notify);
    void loadConflicts();
  }, [loadConflicts, t]);

  // Charge les séances (semaine / mois) ou l'agrégat annuel selon la portée.
  useEffect(() => {
    if (!hasApi()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const st = statuses.length > 0 ? statuses : undefined;
    const run = async (): Promise<void> => {
      try {
        if (scope === 'year') {
          setSessions([]);
          if (yearId == null) {
            setAnnual([]);
            return;
          }
          const res = await api().timetable.annual({ academicYearId: yearId });
          if (cancelled) return;
          if (res.ok) setAnnual(res.data);
          else {
            setAnnual([]);
            setError(errorMessage(res));
          }
          return;
        }
        if (scope === 'month') {
          const res = await api().timetable.month({
            year: monthValue.year(),
            month: monthValue.month() + 1,
            statuses: st,
          });
          if (cancelled) return;
          if (res.ok) setSessions(res.data);
          else {
            setSessions([]);
            setError(errorMessage(res));
          }
          return;
        }
        // Portées à grille hebdo : week + master/professor/room.
        const needsEntity =
          scope !== 'week' && entityId == null;
        if (needsEntity) {
          setSessions([]);
          setOccupancy([]);
          return;
        }
        const [sessRes, occRes] = await Promise.all([
          api().timetable.week({
            weekStart: weekStartIso,
            statuses: st,
            moduleId: scope === 'week' ? moduleId : undefined,
            ...entityFilter,
          }),
          scope === 'room' && entityId != null
            ? api().timetable.occupancy({ weekStart: weekStartIso, roomId: entityId })
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (sessRes.ok) setSessions(sessRes.data);
        else {
          setSessions([]);
          setError(errorMessage(sessRes));
        }
        if (occRes) {
          if (occRes.ok) setOccupancy(occRes.data);
          else {
            setOccupancy([]);
            void message.error(errorMessage(occRes));
          }
        } else {
          setOccupancy([]);
        }
      } catch (err) {
        if (!cancelled) {
          setSessions([]);
          setOccupancy([]);
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [
    scope, weekStartIso, monthValue, yearId, entityId,
    entityFilter, statuses, moduleId, reloadKey,
  ]);

  /** Vide le surlignage conflit (navigation, changement d'entité…). */
  const clearHighlight = (): void => {
    setConflictIds(new Set());
    setConflictKind(null);
  };

  const openSession = async (id: number): Promise<void> => {
    // Request-id : les réponses obsolètes (clic rapide sur un autre
    // bloc) sont ignorées — le drawer affiche toujours la dernière.
    const req = ++detailReq.current;
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api().sessions.get(id);
      if (req !== detailReq.current) return;
      if (res.ok) setDetail(res.data);
      else {
        void message.error(errorMessage(res));
        setDetail(null);
      }
    } catch (err) {
      if (req !== detailReq.current) return;
      void message.error(errorMessage(err));
      setDetail(null);
    } finally {
      if (req === detailReq.current) setDetailLoading(false);
    }
  };

  /** Clic sur un conflit : toujours basculer en portée 'week' + surligner. */
  const jumpToConflict = (c: ConflictItem): void => {
    setConflictIds(new Set(c.sessions.map((s) => s.id)));
    setConflictKind(c.kind);
    setScope('week');
    setEntityId(undefined);
    setWeekStart(mondayOf(dayjs(c.date)));
  };

  // --- Mutations P7b -----------------------------------------------------------

  /** minutes depuis minuit pour un dayjs (heure de début/fin). */
  const minOf = (d: Dayjs): number => d.hour() * 60 + d.minute();

  /**
   * Applique un `SessionEditResult` : succès → toast + reload semaine +
   * panneau conflits (BR-11) + callback ; refus BR-10 → Modal détaillée
   * (jamais de toast seul) ; autre échec → toast erreur.
   */
  const applyEditResult = (
    res: SessionEditResult,
    okMessage: string,
    onSuccess?: () => void,
  ): void => {
    if (res.ok) {
      void message.success(okMessage);
      setReloadKey((k) => k + 1);
      void loadConflicts();
      onSuccess?.();
      return;
    }
    if (res.conflicts && res.conflicts.length > 0) {
      setRefusal(res.conflicts);
    } else {
      void message.error(res.error);
    }
  };

  /** Recharge la fiche du drawer après une mutation (statut + historique). */
  const refreshDetail = (): void => {
    if (detail) void openSession(detail.session.id);
  };

  // -- Modifier (déplacement : date/heure/salle/prof, statut inchangé) --

  const openEdit = (): void => {
    if (!detail) return;
    const s = detail.session;
    const day = dayjs(s.date).startOf('day');
    editForm.setFieldsValue({
      date: dayjs(s.date),
      range: [day.add(s.start_min, 'minute'), day.add(s.end_min, 'minute')],
      room_id: s.room.id,
      professor_id: s.professor.id,
      reason: undefined,
    });
    setEditOpen(true);
  };

  const submitEdit = async (): Promise<void> => {
    if (!detail) return;
    const v = (await editForm.validateFields()) as {
      date: Dayjs;
      range: [Dayjs, Dayjs];
      room_id: number;
      professor_id: number;
      reason?: string;
    };
    setMutating(true);
    try {
      const res = await api().sessions.move(detail.session.id, {
        date: v.date.format('YYYY-MM-DD'),
        start_min: minOf(v.range[0]),
        end_min: minOf(v.range[1]),
        room_id: v.room_id,
        professor_id: v.professor_id,
        reason: v.reason?.trim() || null,
      });
      applyEditResult(res, t('sessions.edit.saved'), () => {
        setEditOpen(false);
        refreshDetail();
      });
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setMutating(false);
    }
  };

  // -- Statut --

  /** Actions de statut proposées selon le statut STOCKÉ de la séance. */
  const statusMenuItems = useMemo(() => {
    if (!detail) return [];
    const st = detail.session.status;
    if (st === 'REALISEE') {
      return [
        { key: 'CORRECTIVE', label: t('sessions.status.corrective') },
      ];
    }
    const items: { key: string; label: string }[] = [
      { key: 'REALISEE', label: t('sessions.status.toRealisee') },
    ];
    if (st === 'PREVUE' || st === 'REPORTEE') {
      items.push(
        { key: 'REPORTEE', label: t('sessions.status.toReportee') },
        { key: 'ANNULEE', label: t('sessions.status.toAnnulee') },
      );
    }
    if (st === 'ANNULEE' || st === 'REPORTEE') {
      items.push({ key: 'PREVUE', label: t('sessions.status.toPrevue') });
    }
    return items;
  }, [detail, t]);

  const doSetStatus = async (input: SessionStatusInput): Promise<void> => {
    if (!detail) return;
    setMutating(true);
    try {
      const res = await api().sessions.setStatus(detail.session.id, input);
      applyEditResult(res, t('sessions.status.updated'), () => {
        setStatusAction(null);
        refreshDetail();
      });
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setMutating(false);
    }
  };

  const onStatusMenu = (key: string): void => {
    if (!detail) return;
    if (key === 'PREVUE') {
      // Réactivation : confirm simple, le re-check conflits est côté main.
      Modal.confirm({
        title: t('sessions.status.toPrevue'),
        content: t('sessions.status.confirmPrevue'),
        okText: t('common.ok'),
        cancelText: t('common.cancel'),
        onOk: () => doSetStatus({ status: 'PREVUE' }),
      });
      return;
    }
    const action = key as 'REALISEE' | 'REPORTEE' | 'ANNULEE' | 'CORRECTIVE';
    const s = detail.session;
    const day = dayjs(s.date).startOf('day');
    statusForm.resetFields();
    statusForm.setFieldsValue({
      reason: undefined,
      target: 'PREVUE',
      actual_date: dayjs(s.date),
      actual_range: [
        day.add(s.start_min, 'minute'),
        day.add(s.end_min, 'minute'),
      ],
      date: undefined,
      range: undefined,
    });
    setStatusAction(action);
  };

  const submitStatus = async (): Promise<void> => {
    const v = (await statusForm.validateFields()) as {
      reason?: string;
      target?: SessionStatus;
      actual_date?: Dayjs;
      actual_range?: [Dayjs, Dayjs];
      date?: Dayjs;
      range?: [Dayjs, Dayjs];
    };
    const reason = v.reason?.trim() || undefined;
    let input: SessionStatusInput;
    if (statusAction === 'REALISEE') {
      input = {
        status: 'REALISEE',
        reason: reason ?? null,
        actual_date: v.actual_date?.format('YYYY-MM-DD'),
        actual_start_min: v.actual_range ? minOf(v.actual_range[0]) : undefined,
        actual_end_min: v.actual_range ? minOf(v.actual_range[1]) : undefined,
      };
    } else if (statusAction === 'REPORTEE') {
      input = {
        status: 'REPORTEE',
        reason: reason ?? null,
        date: v.date?.format('YYYY-MM-DD'),
        start_min: v.range ? minOf(v.range[0]) : undefined,
        end_min: v.range ? minOf(v.range[1]) : undefined,
      };
    } else if (statusAction === 'ANNULEE') {
      input = { status: 'ANNULEE', reason: reason ?? null };
    } else {
      // CORRECTIVE : sortie de REALISEE (admin) — motif obligatoire.
      input = {
        status: v.target ?? 'PREVUE',
        corrective: true,
        reason: reason ?? null,
        ...(v.target === 'REPORTEE'
          ? {
              date: v.date?.format('YYYY-MM-DD'),
              start_min: v.range ? minOf(v.range[0]) : undefined,
              end_min: v.range ? minOf(v.range[1]) : undefined,
            }
          : {}),
      };
    }
    await doSetStatus(input);
  };

  // -- Groupes (session_group) --

  const openGroups = async (): Promise<void> => {
    if (!detail) return;
    try {
      // Groupes du master + student_group_id du mm (à exclure de la
      // sélection : il est implicite, pas dans session_group).
      const res = await api().masters.get(detail.session.master.id);
      if (!res.ok) {
        void message.error(errorMessage(res));
        return;
      }
      const mm = res.data.modules.find(
        (m) => m.id === detail.session.master_module_id,
      );
      const mmGid = mm?.student_group_id ?? null;
      setMasterGroups(res.data.groups);
      setMmGroupId(mmGid);
      groupsForm.setFieldsValue({
        group_ids: detail.groups
          .filter((g) => g.id !== mmGid)
          .map((g) => g.id),
      });
      setGroupsOpen(true);
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  const submitGroups = async (): Promise<void> => {
    if (!detail) return;
    const v = (await groupsForm.validateFields()) as { group_ids?: number[] };
    setMutating(true);
    try {
      const res = await api().sessions.setGroups(
        detail.session.id,
        v.group_ids ?? [],
      );
      applyEditResult(res, t('sessions.groups.saved'), () => {
        setGroupsOpen(false);
        refreshDetail();
      });
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setMutating(false);
    }
  };

  // -- Suppression --

  const doDelete = async (): Promise<void> => {
    if (!detail) return;
    try {
      const res = await api().sessions.remove(detail.session.id);
      applyEditResult(res, t('sessions.delete.done'), () => {
        setDetailOpen(false);
        setDetail(null);
      });
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  // -- Création manuelle --

  const openCreate = (): void => {
    createForm.resetFields();
    setCreateDetail(null);
    setCreateOpen(true);
  };

  const onCreateMaster = async (masterId: number): Promise<void> => {
    createForm.setFieldsValue({
      master_module_id: undefined,
      professor_id: undefined,
      group_ids: [],
    });
    setCreateDetail(null);
    try {
      const res = await api().masters.get(masterId);
      if (res.ok) setCreateDetail(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  const onCreateMm = (mmId: number): void => {
    // Le professeur du master-module est proposé par défaut.
    const mm = createDetail?.modules.find((m) => m.id === mmId);
    if (mm) createForm.setFieldsValue({ professor_id: mm.professor_id });
  };

  const submitCreate = async (): Promise<void> => {
    const v = (await createForm.validateFields()) as {
      master_module_id: number;
      professor_id: number;
      room_id: number;
      date: Dayjs;
      range: [Dayjs, Dayjs];
      group_ids?: number[];
      comment?: string;
    };
    setMutating(true);
    try {
      const res = await api().sessions.create({
        master_module_id: v.master_module_id,
        professor_id: v.professor_id,
        room_id: v.room_id,
        date: v.date.format('YYYY-MM-DD'),
        start_min: minOf(v.range[0]),
        end_min: minOf(v.range[1]),
        group_ids: v.group_ids ?? [],
        comment: v.comment?.trim() || null,
      });
      applyEditResult(res, t('sessions.created'), () => {
        setCreateOpen(false);
        // Bascule la vue semaine sur la semaine de la séance créée.
        setScope('week');
        setWeekStart(mondayOf(v.date));
      });
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setMutating(false);
    }
  };

  const weekdays = t('weekdays', { returnObjects: true }) as unknown as string[];

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day')),
    [weekStart],
  );

  const sessionsByDay = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const list = map.get(s.date) ?? [];
      list.push(s);
      map.set(s.date, list);
    }
    return map;
  }, [sessions]);

  const occupancyByDay = useMemo(() => {
    const map = new Map<string, OccupancyRow[]>();
    for (const o of occupancy) {
      const list = map.get(o.date) ?? [];
      list.push(o);
      map.set(o.date, list);
    }
    return map;
  }, [occupancy]);

  // --- Vue semaine -------------------------------------------------------------

  const weekGrid = (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      {/* En-têtes jours */}
      <div style={{ display: 'flex', borderBottom: '1px solid #E5E7EB' }}>
        <div style={{ width: 56, flexShrink: 0 }} />
        {days.map((d, i) => (
          <div
            key={d.format('YYYY-MM-DD')}
            style={{
              flex: 1,
              padding: '6px 4px',
              textAlign: 'center',
              borderLeft: '1px solid #E5E7EB',
              background: d.isSame(dayjs(), 'day') ? '#2563EB14' : '#fff',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12 }}>
              {weekdays[i]}
            </div>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {d.format('DD/MM')}
            </Text>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', position: 'relative' }}>
        {/* Axe horaire */}
        <div style={{ width: 56, flexShrink: 0, position: 'relative' }}>
          {HOURS.map((h) => (
            <div
              key={h}
              style={{
                position: 'absolute',
                top: h - DAY_START,
                right: 8,
                fontSize: 11,
                color: '#9CA3AF',
                transform: 'translateY(-50%)',
              }}
            >
              {minToHHMM(h)}
            </div>
          ))}
        </div>
        {/* Colonnes jours */}
        {days.map((d) => {
          const key = d.format('YYYY-MM-DD');
          const daySessions = computeLanes(sessionsByDay.get(key) ?? []);
          const dayOcc = occupancyByDay.get(key) ?? [];
          return (
            <div
              key={key}
              style={{
                flex: 1,
                position: 'relative',
                height: DAY_END - DAY_START,
                borderLeft: '1px solid #E5E7EB',
                overflow: 'hidden',
                background:
                  'repeating-linear-gradient(to bottom, #fff 0, #fff 59px, #F4F5F7 59px, #F4F5F7 60px)',
              }}
            >
              {dayOcc.map((o) => (
                <OccupancyBlock key={`occ-${o.id}`} occ={o} />
              ))}
              {daySessions.map((s) => (
                <SessionBlock
                  key={s.id}
                  session={s}
                  highlight={conflictIds.has(s.id)}
                  highlightColor={
                    conflictKind ? KIND_COLORS[conflictKind] : KIND_COLORS.ROOM
                  }
                  onClick={() => void openSession(s.id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );

  // --- Vue mois ----------------------------------------------------------------

  const monthByDay = useMemo(() => {
    const map = new Map<string, Map<EffectiveSessionStatus, number>>();
    for (const s of sessions) {
      const st = map.get(s.date) ?? new Map<EffectiveSessionStatus, number>();
      st.set(s.effective_status, (st.get(s.effective_status) ?? 0) + 1);
      map.set(s.date, st);
    }
    return map;
  }, [sessions]);

  const monthView = (
    <Card size="small">
      <Calendar
        mode="month"
        value={monthValue}
        onChange={(d) => setMonthValue(d)}
        onSelect={(d, { source }) => {
          if (source === 'date') {
            setWeekStart(mondayOf(d));
            setScope('week');
          }
        }}
        fullCellRender={(d) => {
          const key = d.format('YYYY-MM-DD');
          const counts = monthByDay.get(key);
          const inMonth = d.month() === monthValue.month();
          return (
            <div
              style={{
                minHeight: 56,
                padding: 4,
                opacity: inMonth ? 1 : 0.35,
              }}
            >
              <div style={{ fontWeight: 600 }}>{d.date()}</div>
              <Space size={4} wrap>
                {counts &&
                  EFFECTIVE_SESSION_STATUSES.map((st) => {
                    const n = counts.get(st) ?? 0;
                    if (n === 0) return null;
                    return (
                      <Tooltip
                        key={st}
                        title={`${t(`sessionStatus.${st}`)} : ${n}`}
                      >
                        <Badge
                          color={STATUS_COLORS[st]}
                          text={<span style={{ fontSize: 11 }}>{n}</span>}
                        />
                      </Tooltip>
                    );
                  })}
              </Space>
            </div>
          );
        }}
      />
    </Card>
  );

  // --- Vue année ----------------------------------------------------------------

  const annualView = useMemo(() => {
    if (scope !== 'year') return null;
    // Toutes les semaines entre la première et la dernière renseignées —
    // les semaines sans séance gardent une colonne vide.
    const weeks: string[] = [];
    const ws = [...new Set(annual.map((r) => r.weekStart))].sort();
    if (ws.length > 0) {
      let d = dayjs(ws[0]);
      const last = dayjs(ws[ws.length - 1]);
      while (!d.isAfter(last)) {
        weeks.push(d.format('YYYY-MM-DD'));
        d = d.add(7, 'day');
      }
    }
    const mastersRows = new Map<
      number,
      { code: string; name: string; cells: Map<string, AnnualRow> }
    >();
    for (const r of annual) {
      const m = mastersRows.get(r.masterId) ?? {
        code: r.masterCode,
        name: r.masterName,
        cells: new Map<string, AnnualRow>(),
      };
      m.cells.set(r.weekStart, r);
      mastersRows.set(r.masterId, m);
    }
    const columns: ColumnsType<{
      masterId: number;
      code: string;
      name: string;
      cells: Map<string, AnnualRow>;
    }> = [
      {
        title: t('timetable.entity.master'),
        dataIndex: 'name',
        fixed: 'left',
        width: 220,
        render: (name: string, row) => (
          <span dir="auto">
            <Text strong>{row.code}</Text> — {name}
          </span>
        ),
      },
      ...weeks.map((w) => ({
        title: dayjs(w).format('DD/MM'),
        key: w,
        width: 64,
        align: 'center' as const,
        render: (_: unknown, row: { cells: Map<string, AnnualRow> }) => {
          const cell = row.cells.get(w);
          if (!cell) return null;
          return (
            <Tooltip
              title={`${t('sessionStatus.PREVUE')}: ${cell.parStatut.prevue} · ` +
                `${t('sessionStatus.REALISEE')}: ${cell.parStatut.realisee} · ` +
                `${t('sessionStatus.ANNULEE')}: ${cell.parStatut.annulee} · ` +
                `${t('sessionStatus.REPORTEE')}: ${cell.parStatut.reportee}`}
            >
              <Button
                size="small"
                type="text"
                onClick={() => {
                  setWeekStart(dayjs(w));
                  setScope('week');
                }}
              >
                {cell.count}
              </Button>
            </Tooltip>
          );
        },
      })),
    ];
    const rows = [...mastersRows.entries()].map(([masterId, m]) => ({
      masterId,
      ...m,
    }));
    return (
      <Card size="small">
        <Table
          size="small"
          rowKey="masterId"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: true }}
          locale={{ emptyText: t('timetable.empty.year') }}
        />
      </Card>
    );
  }, [annual, scope, t]);

  // --- Panneau conflits ---------------------------------------------------------

  const conflictsByKind = useMemo(() => {
    const map = new Map<ConflictKind, ConflictItem[]>();
    for (const c of conflicts) {
      const list = map.get(c.kind) ?? [];
      list.push(c);
      map.set(c.kind, list);
    }
    return map;
  }, [conflicts]);

  const conflictPanel = (
    <Card
      size="small"
      style={{ width: 340, flexShrink: 0 }}
      title={
        <Space>
          <WarningOutlined style={{ color: '#DC2626' }} />
          {t('conflicts.title')}
          <Badge count={conflicts.length} color="#DC2626" />
        </Space>
      }
      extra={
        <Space>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={() => void loadConflicts()}
            title={t('conflicts.refresh')}
          />
          <Button
            size="small"
            type="text"
            onClick={() => setConflictsOpen(false)}
          >
            {t('conflicts.hide')}
          </Button>
        </Space>
      }
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto', padding: 8 } }}
    >
      {conflicts.length === 0 ? (
        <Empty description={t('conflicts.empty')} />
      ) : (
        <Collapse
          size="small"
          ghost
          items={([...conflictsByKind.keys()] as ConflictKind[]).map((kind) => ({
            key: kind,
            label: (
              <Space>
                <Badge color={KIND_COLORS[kind]} />
                {t(`conflicts.kinds.${kind}`)}
                <Text type="secondary">({conflictsByKind.get(kind)!.length})</Text>
              </Space>
            ),
            children: conflictsByKind.get(kind)!.map((c, i) => (
              <div
                key={`${kind}-${i}`}
                role="button"
                tabIndex={0}
                onClick={() => jumpToConflict(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpToConflict(c);
                }}
                style={{
                  padding: '6px 8px',
                  marginBottom: 4,
                  border: '1px solid #E5E7EB',
                  borderLeft: `3px solid ${KIND_COLORS[kind]}`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {dayjs(c.date).format('dddd DD/MM')} ·{' '}
                  {minToHHMM(c.startMin)}–{minToHHMM(c.endMin)}
                </div>
                <div dir="auto" style={{ color: '#4B5563' }}>
                  {c.entityLabel}
                </div>
                <div dir="auto" style={{ color: '#6B7280', fontSize: 11 }}>
                  {c.sessions.map((s) => s.label).join(' ↔ ')}
                </div>
              </div>
            )),
          }))}
        />
      )}
    </Card>
  );

  // --- Barre d'outils -----------------------------------------------------------

  const entitySelect = (): React.JSX.Element | null => {
    if (scope === 'master') {
      return (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('timetable.entity.master')}
          style={{ minWidth: 260 }}
          value={entityId}
          onChange={(v) => {
            clearHighlight();
            setEntityId(v);
          }}
          options={masters.map((m) => ({
            value: m.id,
            label: `${m.code} — ${m.name}`,
          }))}
        />
      );
    }
    if (scope === 'professor') {
      return (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('timetable.entity.professor')}
          style={{ minWidth: 240 }}
          value={entityId}
          onChange={(v) => {
            clearHighlight();
            setEntityId(v);
          }}
          options={professors.map((p) => ({ value: p.id, label: p.full_name }))}
        />
      );
    }
    if (scope === 'room') {
      return (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder={t('timetable.entity.room')}
          style={{ minWidth: 200 }}
          value={entityId}
          onChange={(v) => {
            clearHighlight();
            setEntityId(v);
          }}
          options={rooms.map((r) => ({ value: r.id, label: r.name }))}
        />
      );
    }
    if (scope === 'year') {
      return (
        <Select
          placeholder={t('timetable.entity.year')}
          style={{ minWidth: 160 }}
          value={yearId}
          onChange={setYearId}
          options={years.map((y) => ({ value: y.id, label: y.label }))}
        />
      );
    }
    return null;
  };

  const isWeekGrid =
    scope === 'week' || scope === 'master' || scope === 'professor' || scope === 'room';

  const weekNav = isWeekGrid ? (
    <Space>
      <Button
        icon={<LeftOutlined />}
        onClick={() => {
          clearHighlight();
          setWeekStart((w) => w.subtract(7, 'day'));
        }}
      />
      <Button
        onClick={() => {
          clearHighlight();
          setWeekStart(mondayOf(dayjs()));
        }}
      >
        {t('timetable.week.today')}
      </Button>
      <Button
        icon={<RightOutlined />}
        onClick={() => {
          clearHighlight();
          setWeekStart((w) => w.add(7, 'day'));
        }}
      />
      <Text strong>
        {t('timetable.week.label', {
          date: weekStart.format('D MMMM YYYY'),
        })}
      </Text>
    </Space>
  ) : null;

  // --- Rendu ---------------------------------------------------------------------

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space
        style={{
          width: '100%',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          <CalendarOutlined /> {t('timetable.title')}
        </Title>
        <Select<Scope>
          value={scope}
          onChange={(v) => {
            setScope(v);
            setEntityId(undefined);
            clearHighlight();
          }}
          style={{ minWidth: 200 }}
          options={(
            ['week', 'master', 'professor', 'room', 'month', 'year'] as Scope[]
          ).map((s) => ({ value: s, label: t(`timetable.tabs.${s}`) }))}
        />
      </Space>

      <Space wrap>
        {entitySelect()}
        {weekNav}
        {scope !== 'year' && (
          <Select
            mode="multiple"
            allowClear
            placeholder={t('timetable.filters.status')}
            style={{ minWidth: 260 }}
            value={statuses}
            onChange={setStatuses}
            options={EFFECTIVE_SESSION_STATUSES.map((st) => ({
              value: st,
              label: t(`sessionStatus.${st}`),
            }))}
            maxTagCount={2}
          />
        )}
        {scope === 'week' && (
          <Select
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder={t('timetable.filters.module')}
            style={{ minWidth: 220 }}
            value={moduleId}
            onChange={setModuleId}
            options={modules.map((m) => ({
              value: m.id,
              label: `${m.code} — ${m.name}`,
            }))}
          />
        )}
        {/* P7b : création manuelle (BR-24 — les deux profils écrivent) */}
        <Button icon={<PlusOutlined />} onClick={openCreate}>
          {t('sessions.create')}
        </Button>
      </Space>

      {error && <Alert type="error" showIcon message={error} />}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading ? (
            <Card>
              <Skeleton active />
            </Card>
          ) : isWeekGrid ? (
            scope !== 'week' && entityId == null ? (
              <Card>
                <Empty description={t('timetable.empty.entity')} />
              </Card>
            ) : sessions.length === 0 && occupancy.length === 0 ? (
              <Card>
                <Empty description={t('timetable.empty.week')} />
              </Card>
            ) : (
              weekGrid
            )
          ) : scope === 'month' ? (
            monthView
          ) : (
            annualView
          )}
        </div>
        {conflictsOpen ? (
          conflictPanel
        ) : (
          <Button
            type="text"
            onClick={() => setConflictsOpen(true)}
            style={{ flexShrink: 0 }}
          >
            <Badge count={conflicts.length} color="#DC2626">
              <WarningOutlined style={{ fontSize: 18 }} />
            </Badge>
          </Button>
        )}
      </div>

      {/* Drawer détail séance */}
      <Drawer
        title={t('timetable.detail.title')}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={480}
      >
        {detailLoading ? (
          <Skeleton active />
        ) : detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Actions P7b — BR-24 : les deux profils écrivent */}
            <Space wrap>
              <Button icon={<EditOutlined />} onClick={openEdit}>
                {t('sessions.edit.action')}
              </Button>
              <Dropdown
                menu={{
                  items: statusMenuItems,
                  onClick: ({ key }) => onStatusMenu(key),
                }}
                disabled={statusMenuItems.length === 0}
              >
                <Button>
                  {t('sessions.status.action')} <DownOutlined />
                </Button>
              </Dropdown>
              <Button icon={<TeamOutlined />} onClick={() => void openGroups()}>
                {t('sessions.groups.action')}
              </Button>
              <Popconfirm
                title={t('sessions.delete.title')}
                description={t('sessions.delete.confirm')}
                okText={t('common.delete')}
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true }}
                onConfirm={() => void doDelete()}
              >
                <Button danger icon={<DeleteOutlined />}>
                  {t('sessions.delete.action')}
                </Button>
              </Popconfirm>
            </Space>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('timetable.detail.date')}>
                {dayjs(detail.session.date).format('dddd DD/MM/YYYY')}
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.time')}>
                {minToHHMM(detail.session.start_min)}–
                {minToHHMM(detail.session.end_min)}
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.status')}>
                <Tag color={STATUS_COLORS[detail.session.effective_status]}>
                  {t(`sessionStatus.${detail.session.effective_status}`)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.module')}>
                <span dir="auto">
                  {detail.session.module.code} — {detail.session.module.name}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.master')}>
                <span dir="auto">
                  {detail.session.master.code} — {detail.session.master.name}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.professor')}>
                <span dir="auto">{detail.session.professor.full_name}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.room')}>
                {detail.session.room.name}
                {detail.session.room.capacity != null &&
                  ` (${detail.session.room.capacity})`}
              </Descriptions.Item>
              <Descriptions.Item label={t('timetable.detail.group')}>
                <span dir="auto">
                  {detail.groups.length > 0
                    ? detail.groups.map((g) => g.name).join(', ')
                    : t('groups.wholeMaster')}
                </span>
              </Descriptions.Item>
              {detail.session.comment && (
                <Descriptions.Item label={t('timetable.detail.comment')}>
                  <span dir="auto">{detail.session.comment}</span>
                </Descriptions.Item>
              )}
              {(detail.session.actual_date ||
                detail.session.actual_start_min != null) && (
                <Descriptions.Item label={t('timetable.detail.actual')}>
                  {detail.session.actual_date ?? ''}{' '}
                  {detail.session.actual_start_min != null &&
                  detail.session.actual_end_min != null
                    ? `${minToHHMM(detail.session.actual_start_min)}–${minToHHMM(detail.session.actual_end_min)}`
                    : ''}
                </Descriptions.Item>
              )}
            </Descriptions>
            <div>
              <Text strong>{t('timetable.detail.history')}</Text>
              {detail.history.length === 0 ? (
                <Empty description={t('timetable.detail.noHistory')} />
              ) : (
                <Timeline
                  style={{ marginTop: 12 }}
                  items={detail.history.map((h) => ({
                    children: (
                      <div>
                        <Text>
                          {h.old_status
                            ? `${t(`sessionStatus.${h.old_status}`)} → `
                            : ''}
                          {t(`sessionStatus.${h.new_status}`)}
                        </Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {h.changed_at}
                          {h.user_name ? (
                            <span dir="auto"> · {h.user_name}</span>
                          ) : (
                            ''
                          )}
                          {h.reason ? (
                            <span dir="auto"> — {h.reason}</span>
                          ) : (
                            ''
                          )}
                        </Text>
                        {h.new_date && (
                          <>
                            <br />
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t('timetable.detail.rescheduled', {
                                date: h.new_date,
                                start:
                                  h.new_start_min != null
                                    ? minToHHMM(h.new_start_min)
                                    : '',
                                end:
                                  h.new_end_min != null
                                    ? minToHHMM(h.new_end_min)
                                    : '',
                              })}
                            </Text>
                          </>
                        )}
                      </div>
                    ),
                  }))}
                />
              )}
            </div>
          </Space>
        ) : (
          <Empty description={t('common.empty')} />
        )}
      </Drawer>

      {/* Modal Modifier (déplacement) */}
      <Modal
        title={t('sessions.edit.title')}
        open={editOpen}
        onOk={() => void submitEdit()}
        onCancel={() => setEditOpen(false)}
        confirmLoading={mutating}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="date"
            label={t('sessions.edit.date')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
          </Form.Item>
          <Form.Item
            name="range"
            label={t('sessions.edit.time')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
          </Form.Item>
          <Form.Item
            name="room_id"
            label={t('sessions.edit.room')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={rooms.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item
            name="professor_id"
            label={t('sessions.edit.professor')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={professors.map((p) => ({
                value: p.id,
                label: p.full_name,
              }))}
            />
          </Form.Item>
          <Form.Item name="reason" label={t('sessions.edit.reason')}>
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal Statut (réalisée / reportée / annulée / correction) */}
      <Modal
        title={
          statusAction === 'CORRECTIVE'
            ? t('sessions.status.correctiveTitle')
            : t('sessions.status.title')
        }
        open={statusAction != null}
        onOk={() => void submitStatus()}
        onCancel={() => setStatusAction(null)}
        confirmLoading={mutating}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form form={statusForm} layout="vertical">
          {statusAction === 'CORRECTIVE' && (
            <Form.Item
              name="target"
              label={t('sessions.status.targetStatus')}
              rules={[{ required: true, message: t('common.required') }]}
            >
              <Select
                options={(['PREVUE', 'ANNULEE', 'REPORTEE'] as const).map(
                  (st) => ({ value: st, label: t(`sessionStatus.${st}`) }),
                )}
              />
            </Form.Item>
          )}
          <Form.Item
            name="reason"
            label={t('sessions.status.reason')}
            rules={[
              {
                required: statusAction !== 'REALISEE',
                message: t('common.required'),
              },
            ]}
          >
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
          {statusAction === 'REALISEE' && (
            <>
              <Form.Item
                name="actual_date"
                label={t('sessions.status.actual')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
              </Form.Item>
              <Form.Item
                name="actual_range"
                label={t('sessions.edit.time')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
              </Form.Item>
            </>
          )}
          {statusAction === 'REPORTEE' && (
            <>
              <Form.Item
                name="date"
                label={t('sessions.status.newSlot')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
              </Form.Item>
              <Form.Item
                name="range"
                label={t('sessions.edit.time')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
              </Form.Item>
            </>
          )}
          {statusAction === 'CORRECTIVE' && (
            <Form.Item noStyle shouldUpdate>
              {() =>
                statusForm.getFieldValue('target') === 'REPORTEE' ? (
                  <>
                    <Form.Item
                      name="date"
                      label={t('sessions.status.newSlot')}
                      rules={[{ required: true, message: t('common.required') }]}
                    >
                      <DatePicker
                        style={{ width: '100%' }}
                        format="DD/MM/YYYY"
                      />
                    </Form.Item>
                    <Form.Item
                      name="range"
                      label={t('sessions.edit.time')}
                      rules={[{ required: true, message: t('common.required') }]}
                    >
                      <TimePicker.RangePicker
                        format="HH:mm"
                        minuteStep={5}
                      />
                    </Form.Item>
                  </>
                ) : null
              }
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* Modal Groupes */}
      <Modal
        title={t('sessions.groups.title')}
        open={groupsOpen}
        onOk={() => void submitGroups()}
        onCancel={() => setGroupsOpen(false)}
        confirmLoading={mutating}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message={
            mmGroupId != null
              ? `${t('sessions.groups.hint')} · ${t('sessions.groups.implicit')} : ${
                  masterGroups.find((g) => g.id === mmGroupId)?.name ?? ''
                }`
              : `${t('sessions.groups.hint')} · ${t('groups.wholeMaster')}`
          }
          style={{ marginBottom: 12 }}
        />
        <Form form={groupsForm} layout="vertical">
          <Form.Item name="group_ids" label={t('sessions.groups.action')}>
            <Select
              mode="multiple"
              allowClear
              optionFilterProp="label"
              options={masterGroups.map((g) => ({
                value: g.id,
                label: g.name,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal Création manuelle */}
      <Modal
        title={t('sessions.createTitle')}
        open={createOpen}
        onOk={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={mutating}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
        width={520}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="master_id"
            label={t('sessions.masterPick')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={masters.map((m) => ({
                value: m.id,
                label: `${m.code} — ${m.name}`,
              }))}
              onChange={(v: number) => void onCreateMaster(v)}
            />
          </Form.Item>
          <Form.Item
            name="master_module_id"
            label={t('sessions.masterModule')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              optionFilterProp="label"
              disabled={createDetail == null}
              onChange={onCreateMm}
              options={(createDetail?.modules ?? []).map((mm) => ({
                value: mm.id,
                label: `${mm.module_code} — ${mm.module_name}${
                  mm.group_name ? ` · ${mm.group_name}` : ''
                }`,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="date"
            label={t('sessions.edit.date')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
          </Form.Item>
          <Form.Item
            name="range"
            label={t('sessions.edit.time')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
          </Form.Item>
          <Form.Item
            name="room_id"
            label={t('sessions.edit.room')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={rooms.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item
            name="professor_id"
            label={t('sessions.edit.professor')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={professors.map((p) => ({
                value: p.id,
                label: p.full_name,
              }))}
            />
          </Form.Item>
          <Form.Item name="group_ids" label={t('sessions.groupsOptional')}>
            <Select
              mode="multiple"
              allowClear
              optionFilterProp="label"
              disabled={createDetail == null}
              options={(createDetail?.groups ?? []).map((g) => ({
                value: g.id,
                label: g.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="comment" label={t('sessions.commentField')}>
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal refus BR-10 — liste détaillée des conflits (jamais de toast seul) */}
      <Modal
        title={
          <Space>
            <WarningOutlined style={{ color: '#DC2626' }} />
            {t('sessions.refusal.title')}
          </Space>
        }
        open={refusal != null}
        footer={
          <Button type="primary" onClick={() => setRefusal(null)}>
            {t('common.ok')}
          </Button>
        }
        onCancel={() => setRefusal(null)}
      >
        <Alert
          type="error"
          showIcon
          message={t('sessions.refusal.body')}
          style={{ marginBottom: 12 }}
        />
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          {(refusal ?? []).map((c, i) => (
            <div
              key={`${c.kind}-${i}`}
              style={{
                padding: '6px 8px',
                border: '1px solid #E5E7EB',
                borderLeft: `3px solid ${KIND_COLORS[c.kind]}`,
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <Space size={6}>
                <Tag color={KIND_COLORS[c.kind]}>
                  {t(`conflicts.kinds.${c.kind}`)}
                </Tag>
                <Text strong dir="auto">
                  {c.entityLabel}
                </Text>
              </Space>
              <div style={{ marginTop: 2 }}>
                {dayjs(c.date).format('dddd DD/MM/YYYY')} ·{' '}
                {t('sessions.refusal.overlap')}{' '}
                {minToHHMM(c.startMin)}–{minToHHMM(c.endMin)}
              </div>
              <div dir="auto" style={{ color: '#6B7280' }}>
                {c.sessions.length > 0
                  ? c.sessions.map((s) => s.label).join(' ↔ ')
                  : c.detail}
              </div>
            </div>
          ))}
        </Space>
      </Modal>
    </Space>
  );
}
