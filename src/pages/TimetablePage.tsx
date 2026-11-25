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
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Calendar,
  Card,
  Collapse,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CalendarOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { FormInstance } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import {
  KIND_COLORS,
  minToHHMM,
  SessionConflictsModal,
  SessionDrawer,
  STATUS_COLORS,
} from '../components/SessionDrawer';
import type {
  AcademicYearRef,
  AnnualRow,
  ConflictItem,
  ConflictKind,
  EffectiveSessionStatus,
  FreeRoomsGrid,
  MasterDetail,
  MasterRow,
  Module,
  OccupancyRow,
  PlacementConflict,
  ProfessorRow,
  Room,
  RoomReassignPreview,
  RoomReassignProposal,
  RoomReassignResult,
  SessionEditResult,
  SessionRow,
} from '../../shared/types';
import { EFFECTIVE_SESSION_STATUSES } from '../../shared/types';

const { Text, Title } = Typography;

type Scope =
  | 'week'
  | 'master'
  | 'professor'
  | 'room'
  | 'month'
  | 'year'
  | 'freeRooms';

const DAY_START = 7 * 60; // 07:00
const DAY_END = 20 * 60; // 20:00 → axe 780 min

/** Niveaux de zoom de la grille hebdo (px par minute). */
type ZoomLevel = 'compact' | 'standard' | 'large';
const ZOOM_SCALE: Record<ZoomLevel, number> = {
  compact: 1,
  standard: 1.35,
  large: 1.7,
};
const HOURS = Array.from(
  { length: (DAY_END - DAY_START) / 60 + 1 },
  (_, i) => DAY_START + i * 60,
);

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
  z: number;
  onClick: () => void;
}): React.JSX.Element | null {
  const { session: s, highlight, highlightColor, z, onClick } = props;
  const { t } = useTranslation();
  const color = STATUS_COLORS[s.effective_status];
  // Clip à l'axe 07:00–20:00 (séance débordante ou hors axe).
  const startC = Math.max(s.start_min, DAY_START);
  const endC = Math.min(s.end_min, DAY_END);
  if (endC - startC <= 0) return null;
  const top = (startC - DAY_START) * z;
  const height = Math.max(18, (endC - startC) * z);
  const widthPct = 100 / s.lanes;
  // Lisibilité : taille de texte et retour à la ligne adaptés au zoom.
  const fontSize = z >= 1.5 ? 12.5 : z > 1 ? 12 : 11;
  const canWrap = height >= 55;
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
        borderRadius: 5,
        padding: '3px 5px',
        overflow: 'hidden',
        cursor: 'pointer',
        fontSize,
        lineHeight: 1.3,
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
          fontWeight: 500,
          textDecoration:
            s.effective_status === 'ANNULEE' ? 'line-through' : 'none',
          ...(canWrap
            ? {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const,
              }
            : { whiteSpace: 'nowrap' as const }),
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

function OccupancyBlock(props: {
  occ: OccupancyRow;
  z: number;
}): React.JSX.Element | null {
  const { occ, z } = props;
  const startC = Math.max(occ.start_min, DAY_START);
  const endC = Math.min(occ.end_min, DAY_END);
  if (endC - startC <= 0) return null;
  const top = (startC - DAY_START) * z;
  const height = Math.max(16, (endC - startC) * z);
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
          borderRadius: 5,
          padding: '2px 4px',
          overflow: 'hidden',
          fontSize: z > 1 ? 12 : 11,
          lineHeight: 1.25,
          color: '#4B5563',
          // Zone bloquée : ni création ni détail — pas le curseur « cell ».
          cursor: 'default',
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
  const [zoom, setZoom] = useState<ZoomLevel>('standard');
  const z = ZOOM_SCALE[zoom];
  // Aperçu « créneau possible » suivant la souris sur la grille hebdo.
  const [ghost, setGhost] = useState<{
    dayKey: string;
    startMin: number;
  } | null>(null);
  const [weekStart, setWeekStart] = useState<Dayjs>(() => mondayOf(dayjs()));
  const [entityId, setEntityId] = useState<number | undefined>(undefined);
  const [monthValue, setMonthValue] = useState<Dayjs>(() => dayjs());
  const [yearId, setYearId] = useState<number | undefined>(undefined);
  // P18 — vue « Dispo salles » : durée du créneau candidat + grille.
  const [freeRoomsDuration, setFreeRoomsDuration] = useState<number>(120);
  const [freeRooms, setFreeRooms] = useState<FreeRoomsGrid | null>(null);

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
  // --- P16 — réaffectation assistée des salles ---------------------------------
  const [reassignCount, setReassignCount] = useState<number | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignPreview, setReassignPreview] =
    useState<RoomReassignPreview | null>(null);
  const [reassignResult, setReassignResult] =
    useState<RoomReassignResult | null>(null);
  const [reassignLoading, setReassignLoading] = useState(false);
  const [reassignApplying, setReassignApplying] = useState(false);
  const [conflictIds, setConflictIds] = useState<Set<number>>(new Set());
  const [conflictKind, setConflictKind] = useState<ConflictKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Filtres ----------------------------------------------------------------
  const [statuses, setStatuses] = useState<EffectiveSessionStatus[]>([]);
  const [moduleId, setModuleId] = useState<number | undefined>(undefined);

  // --- Drawer séance (partagé — SessionDrawer gère détail + mutations) ----
  const [drawerSessionId, setDrawerSessionId] = useState<number | null>(null);

  // --- Édition P7b (création manuelle + refus BR-10) ------------------------------
  // reloadKey : incrémenté après chaque mutation → recharge semaine/mois/année.
  const [reloadKey, setReloadKey] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Refus BR-10 : Modal détaillée (jamais un simple toast).
  const [refusal, setRefusal] = useState<PlacementConflict[] | null>(null);
  const [createDetail, setCreateDetail] = useState<MasterDetail | null>(null);
  const [createForm] = Form.useForm();

  // Groupe implicite du mm choisi en création : exclu des options (il est
  // déjà porté par la séance, jamais dans session_group).
  const createMmId = Form.useWatch('master_module_id', createForm);
  const createMmGroupId =
    createDetail?.modules.find((m) => m.id === createMmId)
      ?.student_group_id ?? null;

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
      // P16 : compteur du bouton « Réaffecter les salles » (aperçu
      // recalculé à chaque rafraîchissement des conflits).
      const prev = await api().conflicts.reassignPreview();
      setReassignCount(prev.ok ? prev.data.proposals.length : null);
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
        if (scope === 'freeRooms') {
          // P18 — grille des salles libres (pas de séances/occupation).
          setSessions([]);
          setOccupancy([]);
          setAnnual([]);
          const res = await api().timetable.freeRooms({
            week_start: weekStartIso,
            duration_min: freeRoomsDuration,
          });
          if (cancelled) return;
          if (res.ok) setFreeRooms(res.data);
          else {
            setFreeRooms(null);
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
    entityFilter, statuses, moduleId, reloadKey, freeRoomsDuration,
  ]);

  /** Vide le surlignage conflit (navigation, changement d'entité…). */
  const clearHighlight = (): void => {
    setConflictIds(new Set());
    setConflictKind(null);
  };

  const openSession = (id: number): void => {
    setDrawerSessionId(id);
  };

  /** Clic sur un conflit : toujours basculer en portée 'week' + surligner. */
  const jumpToConflict = (c: ConflictItem): void => {
    setConflictIds(new Set(c.sessions.map((s) => s.id)));
    setConflictKind(c.kind);
    setScope('week');
    setEntityId(undefined);
    setWeekStart(mondayOf(dayjs(c.date)));
  };

  // --- P16 — Réaffectation assistée des salles ----------------------------------

  /** Ouvre la Modal d'aperçu : prévisualisation fraîche à chaque ouverture. */
  const openReassign = async (): Promise<void> => {
    setReassignOpen(true);
    setReassignResult(null);
    setReassignPreview(null);
    setReassignLoading(true);
    try {
      const res = await api().conflicts.reassignPreview();
      if (res.ok) setReassignPreview(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setReassignLoading(false);
    }
  };

  /** Applique la réaffectation : résultat + rechargement conflits + grille. */
  const applyReassign = async (): Promise<void> => {
    setReassignApplying(true);
    try {
      const res = await api().conflicts.reassignApply();
      if (res.ok) {
        setReassignResult(res.data);
        setReloadKey((k) => k + 1);
        void loadConflicts();
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setReassignApplying(false);
    }
  };

  // --- Mutations P7b -----------------------------------------------------------

  /** minutes depuis minuit pour un dayjs (heure de début/fin). */
  const minOf = (d: Dayjs): number => d.hour() * 60 + d.minute();

  /** Champs service → champs Form (les bornes horaires vivent en RangePicker). */
  const FIELD_TO_FORM: Record<string, string> = {
    start_min: 'range',
    end_min: 'range',
    actual_start_min: 'actual_range',
    actual_end_min: 'actual_range',
  };

  /**
   * Applique un `SessionEditResult` : succès → toast + reload semaine +
   * panneau conflits (BR-11) + callback ; refus BR-10 → Modal détaillée
   * (jamais de toast seul) ; erreurs de validation → surlignées dans le
   * Form (`res.fields` → `setFields`) ; autre échec → toast erreur.
   */
  const applyEditResult = (
    res: SessionEditResult,
    okMessage: string,
    form?: FormInstance,
    onSuccess?: () => void,
  ): void => {
    if (res.ok) {
      void message.success(okMessage);
      setReloadKey((k) => k + 1);
      void loadConflicts();
      onSuccess?.();
      return;
    }
    if (form && res.fields && res.fields.length > 0) {
      const byName = new Map<string, string[]>();
      for (const f of res.fields) {
        const name = FIELD_TO_FORM[f.field] ?? f.field;
        byName.set(name, [...(byName.get(name) ?? []), f.message]);
      }
      form.setFields(
        [...byName].map(([name, errors]) => ({ name, errors })),
      );
    }
    if (res.conflicts && res.conflicts.length > 0) {
      setRefusal(res.conflicts);
    } else {
      void message.error(res.error);
    }
  };

  // -- Création manuelle --

  const openCreate = (): void => {
    createForm.resetFields();
    setCreateDetail(null);
    setCreateOpen(true);
  };

  /**
   * P14 — Clic-création : ouvre le modal de création pré-rempli avec le
   * jour cliqué et le créneau calculé (snap 15 min, +120 borné à 20:00).
   * Vue « Par Master » + master sélectionné → master_id pré-rempli
   * (le master-module reste à choisir) ; sinon master libre.
   * P18 — `roomId` pré-remplit la salle (clic depuis « Dispo salles »).
   */
  const openCreateAt = (
    day: Dayjs,
    startMin: number,
    endMin: number,
    roomId?: number,
  ): void => {
    createForm.resetFields();
    setCreateDetail(null);
    const day0 = day.startOf('day');
    createForm.setFieldsValue({
      master_id: undefined,
      master_module_id: undefined,
      professor_id: undefined,
      room_id: roomId,
      group_ids: [],
      comment: undefined,
      date: day,
      range: [
        day0.add(startMin, 'minute'),
        day0.add(endMin, 'minute'),
      ],
    });
    if (scope === 'master' && entityId != null) {
      createForm.setFieldsValue({ master_id: entityId });
      void onCreateMaster(entityId);
    }
    setCreateOpen(true);
  };

  /** Position px dans la colonne → minute de début (snap 15 min, borné). */
  const offsetToStartMin = (offsetY: number): number => {
    const span = DAY_END - DAY_START;
    const minutes = Math.max(0, Math.min(offsetY / z, span));
    const snapped = Math.round(minutes / 15) * 15;
    // ≥15 min garanti : le dernier créneau possible s'arrête à DAY_END.
    return Math.min(DAY_START + snapped, DAY_END - 15);
  };

  /** Y du curseur relatif au haut de la colonne (quel que soit le bloc). */
  const columnY = (e: React.MouseEvent<HTMLDivElement>): number =>
    e.clientY - e.currentTarget.getBoundingClientRect().top;

  /**
   * Clic sur la zone vide d'une colonne-jour : ouvre la création au
   * créneau pointé. Les blocs séance/occupation ont leur propre onClick —
   * seul un clic dont la cible est le fond de la colonne
   * (`e.target === e.currentTarget`) déclenche la création.
   */
  const onDayColumnClick = (
    d: Dayjs,
    e: React.MouseEvent<HTMLDivElement>,
  ): void => {
    if (e.target !== e.currentTarget) return;
    const startMin = offsetToStartMin(columnY(e));
    const endMin = Math.min(startMin + 120, DAY_END);
    openCreateAt(d, startMin, endMin);
  };

  /**
   * Survol d'une colonne-jour : aperçu en pointillés du créneau qui
   * serait créé (visibilité des plages libres pour la planification).
   */
  const onDayColumnMove = (
    dayKey: string,
    e: React.MouseEvent<HTMLDivElement>,
  ): void => {
    const startMin = offsetToStartMin(columnY(e));
    setGhost((prev) =>
      prev && prev.dayKey === dayKey && prev.startMin === startMin
        ? prev
        : { dayKey, startMin },
    );
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
    // Le professeur du master-module est proposé par défaut ; le groupe
    // implicite du mm est retiré de la sélection s'il y figurait.
    const mm = createDetail?.modules.find((m) => m.id === mmId);
    if (mm) {
      const picked =
        (createForm.getFieldValue('group_ids') as number[] | undefined) ??
        [];
      createForm.setFieldsValue({
        professor_id: mm.professor_id,
        group_ids: picked.filter((g) => g !== mm.student_group_id),
      });
    }
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
      applyEditResult(res, t('sessions.created'), createForm, () => {
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
              padding: '8px 4px',
              textAlign: 'center',
              borderLeft: '1px solid #E5E7EB',
              background: d.isSame(dayjs(), 'day') ? '#2563EB14' : '#fff',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {weekdays[i]}
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
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
                top: (h - DAY_START) * z,
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
              title={t('timetable.clickToCreate')}
              onClick={(e) => onDayColumnClick(d, e)}
              onMouseMove={(e) => onDayColumnMove(key, e)}
              onMouseLeave={() =>
                setGhost((prev) => (prev?.dayKey === key ? null : prev))
              }
              style={{
                flex: 1,
                position: 'relative',
                height: (DAY_END - DAY_START) * z,
                borderLeft: '1px solid #E5E7EB',
                overflow: 'hidden',
                cursor: 'cell',
                background: `repeating-linear-gradient(to bottom, #fff 0, #fff ${60 * z - 1}px, #F4F5F7 ${60 * z - 1}px, #F4F5F7 ${60 * z}px)`,
              }}
            >
              {dayOcc.map((o) => (
                <OccupancyBlock key={`occ-${o.id}`} occ={o} z={z} />
              ))}
              {daySessions.map((s) => (
                <SessionBlock
                  key={s.id}
                  session={s}
                  highlight={conflictIds.has(s.id)}
                  highlightColor={
                    conflictKind ? KIND_COLORS[conflictKind] : KIND_COLORS.ROOM
                  }
                  z={z}
                  onClick={() => void openSession(s.id)}
                />
              ))}
              {/* Aperçu du créneau possible au survol (clic = créer). */}
              {ghost?.dayKey === key && (
                <div
                  style={{
                    position: 'absolute',
                    top: (ghost.startMin - DAY_START) * z,
                    height: 120 * z,
                    left: 1,
                    right: 1,
                    border: '2px dashed #2563EB',
                    borderRadius: 6,
                    background: 'rgba(37,99,235,0.07)',
                    color: '#2563EB',
                    fontSize: 11,
                    fontWeight: 600,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    pointerEvents: 'none',
                    zIndex: 4,
                  }}
                >
                  <span>+ {t('timetable.ghost.new')}</span>
                  <span>
                    {minToHHMM(ghost.startMin)}–
                    {minToHHMM(Math.min(ghost.startMin + 120, DAY_END))}
                  </span>
                </div>
              )}
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

  // --- Vue « Dispo salles » (P18) ------------------------------------------------

  const freeRoomsView = useMemo(() => {
    if (scope !== 'freeRooms') return null;
    interface GridRow {
      key: number;
      start: number;
      end: number;
    }
    const columns: ColumnsType<GridRow> = [
      {
        title: t('timetable.freeRooms.slot'),
        dataIndex: 'start',
        fixed: 'left',
        width: 110,
        render: (start: number, row) =>
          `${minToHHMM(start)}–${minToHHMM(row.end)}`,
      },
      ...(freeRooms?.days ?? []).map((d, i) => ({
        title: (
          <span
            style={
              dayjs(d.date).isSame(dayjs(), 'day')
                ? { color: '#2563EB', fontWeight: 700 }
                : undefined
            }
          >
            {weekdays[i] ?? ''} {dayjs(d.date).format('DD/MM')}
          </span>
        ),
        key: d.date,
        onCell: () => ({
          style: {
            background:
              d.closed != null
                ? '#F3F4F6'
                : dayjs(d.date).isSame(dayjs(), 'day')
                  ? '#2563EB08'
                  : undefined,
            verticalAlign: 'top',
            padding: '6px 8px',
          },
        }),
        render: (_: unknown, row: GridRow) => {
          if (d.closed != null) {
            return (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('timetable.freeRooms.closed', {
                  type: t(`params.exceptions.types.${d.closed}`),
                })}
              </Text>
            );
          }
          const free = freeRooms?.cells[`${d.date}|${row.start}`];
          if (!free || free.length === 0) {
            return (
              <Text type="secondary" style={{ fontSize: 11 }}>
                —
              </Text>
            );
          }
          return (
            <Space size={4} wrap>
              {free.map((r) => {
                const big = (r.capacity ?? 0) >= 100;
                return (
                  <Tooltip
                    key={r.room_id}
                    title={t('timetable.freeRooms.roomTooltip', {
                      capacity: r.capacity ?? '?',
                    })}
                  >
                    <Tag
                      color={big ? 'geekblue' : 'green'}
                      style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                      onClick={() =>
                        openCreateAt(
                          dayjs(d.date),
                          row.start,
                          row.end,
                          r.room_id,
                        )
                      }
                    >
                      {r.name}
                      {r.capacity != null ? ` · ${r.capacity}` : ''}
                    </Tag>
                  </Tooltip>
                );
              })}
            </Space>
          );
        },
      })),
    ];
    const rows: GridRow[] = (freeRooms?.slots ?? []).map((s) => ({
      key: s.start_min,
      start: s.start_min,
      end: s.end_min,
    }));
    return (
      <Card size="small">
        <Space size={16} wrap style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('timetable.freeRooms.legend')}
          </Text>
          <Tag color="green">{t('timetable.freeRooms.legendSmall')}</Tag>
          <Tag color="geekblue">{t('timetable.freeRooms.legendBig')}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('timetable.freeRooms.legendDash')}
          </Text>
        </Space>
        <Table<GridRow>
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: true }}
          locale={{ emptyText: t('timetable.freeRooms.empty') }}
        />
      </Card>
    );
  }, [scope, freeRooms, t]);

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
      {/* P16 : résolution assistée — désactivée si aucune proposition. */}
      <Tooltip
        title={reassignCount === 0 ? t('conflicts.reassign.none') : undefined}
      >
        <Button
          size="small"
          block
          icon={<SwapOutlined />}
          disabled={reassignCount === 0}
          onClick={() => void openReassign()}
          style={{ marginBottom: 8 }}
        >
          {t('conflicts.reassign.action')}
          {reassignCount != null && reassignCount > 0
            ? ` (${reassignCount})`
            : ''}
        </Button>
      </Tooltip>
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

  // P18 : « Dispo salles » partage la navigation semaine (◀ Aujourd'hui ▶).
  const weekNav = isWeekGrid || scope === 'freeRooms' ? (
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
            [
              'week',
              'master',
              'professor',
              'room',
              'month',
              'year',
              'freeRooms',
            ] as Scope[]
          ).map((s) => ({ value: s, label: t(`timetable.tabs.${s}`) }))}
        />
      </Space>

      <Space wrap>
        {entitySelect()}
        {weekNav}
        {isWeekGrid && (
          <Segmented<ZoomLevel>
            value={zoom}
            onChange={setZoom}
            options={(
              ['compact', 'standard', 'large'] as ZoomLevel[]
            ).map((lvl) => ({
              value: lvl,
              label: t(`timetable.zoom.${lvl}`),
            }))}
          />
        )}
        {scope === 'freeRooms' && (
          <Select
            value={freeRoomsDuration}
            onChange={setFreeRoomsDuration}
            style={{ minWidth: 110 }}
            options={[
              { value: 120, label: '2h' },
              { value: 90, label: '1h30' },
              { value: 60, label: '1h' },
              { value: 180, label: '3h' },
            ]}
          />
        )}
        {scope !== 'year' && scope !== 'freeRooms' && (
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
          ) : scope === 'freeRooms' ? (
            freeRoomsView
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

      {/* Drawer détail séance partagé (P9a — même fiche + actions
          que le registre /seances) */}
      <SessionDrawer
        sessionId={drawerSessionId}
        rooms={rooms}
        professors={professors}
        onClose={() => setDrawerSessionId(null)}
        onChanged={() => {
          setReloadKey((k) => k + 1);
          void loadConflicts();
        }}
      />

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
              options={rooms
                .filter((r) => r.is_active === 1)
                .map((r) => ({ value: r.id, label: r.name }))}
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
              options={professors
                .filter((p) => p.is_active === 1)
                .map((p) => ({ value: p.id, label: p.full_name }))}
            />
          </Form.Item>
          <Form.Item name="group_ids" label={t('sessions.groupsOptional')}>
            <Select
              mode="multiple"
              allowClear
              optionFilterProp="label"
              disabled={createDetail == null}
              options={(createDetail?.groups ?? [])
                .filter((g) => g.id !== createMmGroupId)
                .map((g) => ({
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

      {/* Modal refus BR-10 partagée (création manuelle) */}
      <SessionConflictsModal
        conflicts={refusal}
        onClose={() => setRefusal(null)}
      />

      {/* Modal P16 — aperçu + application de la réaffectation des salles */}
      <Modal
        title={t('conflicts.reassign.title')}
        open={reassignOpen}
        onCancel={() => setReassignOpen(false)}
        width={780}
        destroyOnHidden
        footer={
          reassignResult != null ? (
            <Button type="primary" onClick={() => setReassignOpen(false)}>
              {t('common.close')}
            </Button>
          ) : (
            <Space>
              <Button onClick={() => setReassignOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                type="primary"
                loading={reassignApplying}
                disabled={
                  reassignLoading ||
                  (reassignPreview?.proposals.length ?? 0) === 0
                }
                onClick={() => void applyReassign()}
              >
                {t('conflicts.reassign.apply')}
              </Button>
            </Space>
          )
        }
      >
        {reassignLoading ? (
          <Skeleton active />
        ) : reassignResult != null ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="success"
              showIcon
              message={t('conflicts.reassign.applied', {
                moved: reassignResult.moved,
              })}
            />
            {reassignResult.skipped.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('conflicts.reassign.appliedSkipped', {
                  count: reassignResult.skipped.length,
                })}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {reassignResult.skipped.map((s) => (
                      <li key={s.session_id} dir="auto">
                        {`${dayjs(s.date).format('DD/MM')} ` +
                          `${minToHHMM(s.start_min)}–${minToHHMM(s.end_min)} ` +
                          `· ${s.label} — ${s.reason}`}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}
          </Space>
        ) : reassignPreview != null ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={t('conflicts.reassign.count', {
                count: reassignPreview.proposals.length,
              })}
            />
            <Table<RoomReassignProposal>
              size="small"
              rowKey="session_id"
              dataSource={reassignPreview.proposals}
              pagination={
                reassignPreview.proposals.length > 10
                  ? { pageSize: 10 }
                  : false
              }
              locale={{ emptyText: t('conflicts.reassign.empty') }}
              columns={[
                {
                  title: t('conflicts.reassign.colSession'),
                  render: (_, p) => (
                    <span dir="auto">
                      {`${dayjs(p.date).format('dddd DD/MM')} · ` +
                        `${minToHHMM(p.start_min)}–${minToHHMM(p.end_min)} · ` +
                        `${p.label}`}
                    </span>
                  ),
                },
                {
                  title: t('conflicts.reassign.colRoom'),
                  width: 200,
                  render: (_, p) => (
                    <span dir="auto">{`${p.old_room} → ${p.new_room}`}</span>
                  ),
                },
                {
                  title: t('conflicts.reassign.colKinds'),
                  width: 200,
                  render: (_, p) => (
                    <Space size={4} wrap>
                      {p.kinds.map((k) => (
                        <Tag key={k} color={KIND_COLORS[k]}>
                          {t(`conflicts.kinds.${k}`)}
                        </Tag>
                      ))}
                    </Space>
                  ),
                },
              ]}
            />
            {reassignPreview.skipped.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('conflicts.reassign.skippedTitle', {
                  count: reassignPreview.skipped.length,
                })}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {reassignPreview.skipped.map((s) => (
                      <li key={s.session_id} dir="auto">
                        {`${dayjs(s.date).format('DD/MM')} ` +
                          `${minToHHMM(s.start_min)}–${minToHHMM(s.end_min)} ` +
                          `· ${s.label} — ${s.reason}`}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
