/**
 * SessionDrawer (P7b extrait, P9a partagé) — fiche séance complète
 * réutilisée par TimetablePage et SessionsPage (registre FR-30) :
 * détail + historique des statuts + mêmes actions (modifier le
 * créneau, changer le statut, groupes rattachés, suppression) et la
 * modal de refus BR-10 détaillée.
 *
 * Le parent fournit `sessionId` (null = fermé), les référentiels
 * `rooms`/`professors` déjà chargés, et `onChanged` appelé après chaque
 * mutation (rechargement des données + panneau conflits côté parent).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
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
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileDoneOutlined,
  PrinterOutlined,
  TeamOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { FormInstance } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage } from '../api/client';
import type {
  AttendanceDetail,
  ConflictKind,
  EffectiveSessionStatus,
  PlacementConflict,
  ProfessorRow,
  Room,
  SessionDetail,
  SessionEditResult,
  SessionStatus,
  SessionStatusInput,
  StudentAttendanceStatus,
  StudentGroupRow,
} from '../../shared/types';

const { Text } = Typography;

// Palette statuts — DESIGN.md (un statut = une couleur, partout).
export const STATUS_COLORS: Record<EffectiveSessionStatus, string> = {
  PREVUE: '#2563EB',
  REALISEE: '#16A34A',
  NON_ENCORE_REALISEE: '#D97706',
  ANNULEE: '#9CA3AF',
  REPORTEE: '#7C3AED',
};

export const KIND_COLORS: Record<ConflictKind, string> = {
  ROOM: '#DC2626',
  PROFESSOR: '#D97706',
  MASTER: '#7C3AED',
  GROUP: '#0284C7',
  EXTERNAL: '#4B5563',
};

export function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(
    min % 60,
  ).padStart(2, '0')}`;
}

/**
 * Modal de refus BR-10 (P7b/P9a) — liste détaillée des conflits,
 * jamais un simple toast. Partagée par le drawer, la création manuelle
 * et les décisions d'absence.
 */
export function SessionConflictsModal(props: {
  conflicts: PlacementConflict[] | null;
  onClose: () => void;
}): React.JSX.Element {
  const { conflicts, onClose } = props;
  const { t } = useTranslation();
  return (
    <Modal
      title={
        <Space>
          <WarningOutlined style={{ color: '#DC2626' }} />
          {t('sessions.refusal.title')}
        </Space>
      }
      open={conflicts != null}
      footer={
        <Button type="primary" onClick={onClose}>
          {t('common.ok')}
        </Button>
      }
      onCancel={onClose}
    >
      <Alert
        type="error"
        showIcon
        message={t('sessions.refusal.body')}
        style={{ marginBottom: 12 }}
      />
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        {(conflicts ?? []).map((c, i) => (
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
              {t('sessions.refusal.overlap')} {minToHHMM(c.startMin)}–
              {minToHHMM(c.endMin)}
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
  );
}

// --- Présences (P9b) ----------------------------------------------------------

/**
 * Section « Présences » du drawer (visible uniquement si la séance est
 * REALISEE — une présence n'a de sens que sur un cours tenu, BR-1) :
 * - registre vide → formulaire comptage (présents/absents + note) ;
 * - registre non vide → nominatif possible ; si des lignes nominatives
 *   existent déjà, ouverture directe en nominatif, sinon comptage par
 *   défaut avec lien « Passer en nominatif ».
 * Mode nominatif : une ligne par étudiant (segmented P/A/J), boutons
 * « Tous présents » / « Tous absents », compteur live ; l'ensemble du
 * roster est envoyé (le service n'écrit que les lignes fournies et
 * recalcule les compteurs — un JUSTIFIE reste un absent comptablement).
 * Orphelines (ligne nominative hors groupes candidats, `out_of_roster`) :
 * tag « hors groupe », incluses au submit avec leur statut — l'option
 * segmented « Retirer » les exclut explicitement (pas d'effacement
 * silencieux).
 */
/** Statut affiché au segmented — 'REMOVE' = orpheline à exclure du submit. */
type AttendanceMark = StudentAttendanceStatus | 'REMOVE';

function AttendanceSection({
  sessionId,
}: {
  sessionId: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [data, setData] = useState<AttendanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uiMode, setUiMode] = useState<'COUNT' | 'NOMINATIVE'>('COUNT');
  const [present, setPresent] = useState<number>(0);
  const [absent, setAbsent] = useState<number>(0);
  const [note, setNote] = useState('');
  const [marks, setMarks] = useState<Record<number, AttendanceMark>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api().attendance.get(sessionId);
      if (!res.ok) {
        void message.error(errorMessage(res));
        setData(null);
        return;
      }
      const d = res.data;
      setData(d);
      setPresent(d.counts?.present_count ?? 0);
      setAbsent(d.counts?.absent_count ?? 0);
      setNote(d.counts?.note ?? '');
      const m: Record<number, AttendanceMark> = {};
      // Défaut UI : tout le roster PRESENT, puis statuts enregistrés.
      for (const r of d.roster) m[r.student_id] = 'PRESENT';
      for (const n of d.nominative) m[n.student_id] = n.status;
      setMarks(m);
      setUiMode(d.mode === 'NOMINATIVE' ? 'NOMINATIVE' : 'COUNT');
    } catch (err) {
      void message.error(errorMessage(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Compteur live du mode nominatif — les orphelines « Retirer » sortent du décompte. */
  const live = useMemo(() => {
    let p = 0;
    let j = 0;
    let total = 0;
    for (const r of data?.roster ?? []) {
      const st = marks[r.student_id] ?? 'PRESENT';
      if (st === 'REMOVE') continue; // exclue du submit et du décompte
      total += 1;
      if (st === 'PRESENT') p += 1;
      else if (st === 'JUSTIFIE') j += 1;
    }
    return { present: p, absent: total - p, justified: j };
  }, [data, marks]);

  /** Message d'erreur service complet : erreur + champs concaténés. */
  const submitError = (res: { error: string; fields?: { message: string }[] }): void => {
    const fieldMsgs = (res.fields ?? []).map((f) => f.message).join(' ');
    void message.error(fieldMsgs ? `${res.error} ${fieldMsgs}` : res.error);
  };

  const submitCounts = async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await api().attendance.setCounts(sessionId, {
        present_count: present,
        absent_count: absent,
        note: note.trim() || null,
      });
      if (res.ok) {
        void message.success(t('attendance.saved'));
        void load();
      } else {
        submitError(res);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submitNominative = async (): Promise<void> => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await api().attendance.setNominative(
        sessionId,
        // Orphelines : incluses avec leur statut sauf « Retirer » explicite.
        data.roster
          .filter((r) => marks[r.student_id] !== 'REMOVE')
          .map((r) => ({
            student_id: r.student_id,
            status: (marks[r.student_id] ??
              'PRESENT') as StudentAttendanceStatus,
          })),
      );
      if (res.ok) {
        void message.success(t('attendance.saved'));
        void load();
      } else {
        submitError(res);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const doClear = async (): Promise<void> => {
    setSaving(true);
    try {
      const res = await api().attendance.clear(sessionId);
      if (res.ok) {
        void message.success(t('attendance.cleared'));
        void load();
      } else {
        void message.error(res.error);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const setAll = (status: StudentAttendanceStatus): void => {
    const m: Record<number, AttendanceMark> = {};
    for (const r of data?.roster ?? []) m[r.student_id] = status;
    setMarks(m);
  };

  if (loading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (!data) return <Empty description={t('common.empty')} />;

  const hasSaved = data.counts != null || data.nominative.length > 0;
  const nominativeMode = uiMode === 'NOMINATIVE' && data.roster.length > 0;

  const countsForm = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap>
        <label>
          {t('attendance.present')}{' '}
          <InputNumber
            min={0}
            max={5000}
            precision={0}
            value={present}
            onChange={(v) => setPresent(v ?? 0)}
          />
        </label>
        <label>
          {t('attendance.absent')}{' '}
          <InputNumber
            min={0}
            max={5000}
            precision={0}
            value={absent}
            onChange={(v) => setAbsent(v ?? 0)}
          />
        </label>
      </Space>
      <Input.TextArea
        rows={2}
        maxLength={500}
        dir="auto"
        placeholder={t('attendance.notePlaceholder')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Space wrap>
        <Button
          type="primary"
          loading={saving}
          onClick={() => void submitCounts()}
        >
          {t('common.save')}
        </Button>
        {data.roster.length > 0 && (
          <Button type="link" onClick={() => setUiMode('NOMINATIVE')}>
            {t('attendance.switchToNominative')}
          </Button>
        )}
      </Space>
    </Space>
  );

  const nominativeTable = (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap>
        <Button size="small" onClick={() => setAll('PRESENT')}>
          {t('attendance.allPresent')}
        </Button>
        <Button size="small" onClick={() => setAll('ABSENT')}>
          {t('attendance.allAbsent')}
        </Button>
        <Text type="secondary">
          {t('attendance.counter', {
            present: live.present,
            absent: live.absent,
            justified: live.justified,
          })}
        </Text>
      </Space>
      <Table<AttendanceDetail['roster'][number]>
        size="small"
        rowKey="student_id"
        dataSource={data.roster}
        pagination={false}
        columns={[
          {
            key: 'student',
            title: t('attendance.student'),
            dataIndex: 'full_name',
            render: (v: string, r) => (
              <Space size={6}>
                <span dir="auto">{v}</span>
                {r.out_of_roster === 1 && (
                  <Tag color="orange">{t('attendance.outOfGroup')}</Tag>
                )}
              </Space>
            ),
          },
          {
            key: 'group',
            title: t('attendance.group'),
            dataIndex: 'group_name',
            render: (v: string) => <span dir="auto">{v}</span>,
          },
          {
            key: 'status',
            title: t('timetable.detail.status'),
            render: (_v, r) => (
              <Segmented<AttendanceMark>
                size="small"
                value={marks[r.student_id] ?? 'PRESENT'}
                onChange={(v) =>
                  setMarks((m) => ({ ...m, [r.student_id]: v }))
                }
                options={[
                  { value: 'PRESENT', label: t('attendance.statuses.PRESENT') },
                  { value: 'ABSENT', label: t('attendance.statuses.ABSENT') },
                  { value: 'JUSTIFIE', label: t('attendance.statuses.JUSTIFIE') },
                  // « Retirer » : exclusion explicite, orphelines seulement
                  // (un candidat non soumis = simplement pas de ligne).
                  ...(r.out_of_roster === 1
                    ? [
                        {
                          value: 'REMOVE' as AttendanceMark,
                          label: t('attendance.statuses.REMOVE'),
                        },
                      ]
                    : []),
                ]}
              />
            ),
          },
        ]}
      />
      <Space wrap>
        <Button
          type="primary"
          loading={saving}
          onClick={() => void submitNominative()}
        >
          {t('common.save')}
        </Button>
        {data.nominative.length === 0 && (
          <Button type="link" onClick={() => setUiMode('COUNT')}>
            {t('attendance.switchToCount')}
          </Button>
        )}
      </Space>
    </Space>
  );

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong>{t('attendance.title')}</Text>
        <Space>
          <Tag>{t(nominativeMode ? 'attendance.modeNominative' : 'attendance.modeCount')}</Tag>
          {hasSaved && (
            <Popconfirm
              title={t('attendance.clearTitle')}
              description={t('attendance.clearConfirm')}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={() => void doClear()}
            >
              <Button size="small" danger>
                {t('attendance.clear')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
      <div style={{ marginTop: 8 }}>
        {nominativeMode ? nominativeTable : countsForm}
      </div>
    </div>
  );
}

// --- Saisie groupée de la feuille (P17) --------------------------------------

/**
 * Modal « Saisir la feuille » (P17) — retour de la feuille papier
 * cochée : visible sur PREVUE/REPORTEE, marque la séance REALISEE et
 * enregistre les présences nominatives EN UNE transaction
 * (`sessions:recordSheet`). Horaires réels optionnels (défaut :
 * créneau planifié). Séance sans étudiants → la modale propose
 * simplement le marquage réalisée (comptage impossible).
 * Montée conditionnellement par le parent — état frais à chaque
 * ouverture, roster rechargé via `attendance:get` (lisible sur tout
 * statut).
 */
function SheetEntryModal(props: {
  detail: SessionDetail;
  onClose: () => void;
  /** Succès : parent recharge la séance + ses données. */
  onDone: () => void;
}): React.JSX.Element {
  const { detail, onClose, onDone } = props;
  const { t } = useTranslation();
  const s = detail.session;
  const [form] = Form.useForm();
  const [roster, setRoster] = useState<AttendanceDetail['roster'] | null>(null);
  const [marks, setMarks] = useState<
    Record<number, StudentAttendanceStatus>
  >({});
  const [saving, setSaving] = useState(false);
  const minOfDay = (d: Dayjs): number => d.hour() * 60 + d.minute();

  useEffect(() => {
    let stale = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api().attendance.get(s.id);
        if (stale) return;
        if (!res.ok) {
          void message.error(errorMessage(res));
          setRoster([]);
          return;
        }
        setRoster(res.data.roster);
        const m: Record<number, StudentAttendanceStatus> = {};
        // Défaut : tout présent — on ne coche que les écarts.
        for (const r of res.data.roster) m[r.student_id] = 'PRESENT';
        setMarks(m);
      } catch (err) {
        if (!stale) void message.error(errorMessage(err));
      }
    };
    void load();
    return () => {
      stale = true;
    };
  }, [s.id]);

  const live = useMemo(() => {
    let p = 0;
    let j = 0;
    for (const r of roster ?? []) {
      const st = marks[r.student_id] ?? 'PRESENT';
      if (st === 'PRESENT') p += 1;
      else if (st === 'JUSTIFIE') j += 1;
    }
    const total = (roster ?? []).length;
    return { present: p, absent: total - p, justified: j };
  }, [roster, marks]);

  const submit = async (): Promise<void> => {
    const v = (await form.validateFields()) as {
      actual_date?: Dayjs;
      actual_range?: [Dayjs, Dayjs];
    };
    setSaving(true);
    try {
      const res = await api().sessions.recordSheet(s.id, {
        actual_date: v.actual_date?.format('YYYY-MM-DD'),
        actual_start_min: v.actual_range
          ? minOfDay(v.actual_range[0])
          : undefined,
        actual_end_min: v.actual_range
          ? minOfDay(v.actual_range[1])
          : undefined,
        rows: (roster ?? []).map((r) => ({
          student_id: r.student_id,
          status: marks[r.student_id] ?? 'PRESENT',
        })),
      });
      if (res.ok) {
        void message.success(
          res.data.marked > 0
            ? t('sessions.sheetEntry.saved', { marked: res.data.marked })
            : t('sessions.sheetEntry.savedEmpty'),
        );
        onDone();
        onClose();
        return;
      }
      // Erreurs champ à champ (actual_*) surlignées ; le reste en toast.
      const byName = new Map<string, string[]>();
      for (const f of res.fields ?? []) {
        const name = FIELD_TO_FORM[f.field] ?? f.field;
        byName.set(name, [...(byName.get(name) ?? []), f.message]);
      }
      const formErrors = [...byName].filter(([name]) =>
        ['actual_date', 'actual_range'].includes(name),
      );
      if (formErrors.length > 0) {
        form.setFields(
          formErrors.map(([name, errors]) => ({ name, errors })),
        );
      }
      const otherMsgs = [...byName]
        .filter(([name]) => !['actual_date', 'actual_range'].includes(name))
        .flatMap(([, msgs]) => msgs)
        .join(' ');
      void message.error(
        otherMsgs ? `${res.error} ${otherMsgs}` : res.error,
      );
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const day = dayjs(s.date).startOf('day');

  return (
    <Modal
      title={t('sessions.sheetEntry.title')}
      open
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      width={640}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text type="secondary">
          {dayjs(s.date).format('dddd DD/MM/YYYY')} · {minToHHMM(s.start_min)}–
          {minToHHMM(s.end_min)} ·{' '}
          <span dir="auto">
            {s.module.code} — {s.module.name}
          </span>
        </Text>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            actual_date: dayjs(s.date),
            actual_range: [
              day.add(s.start_min, 'minute'),
              day.add(s.end_min, 'minute'),
            ],
          }}
        >
          <Space wrap size="middle">
            <Form.Item
              name="actual_date"
              label={t('sessions.sheetEntry.actual')}
            >
              <DatePicker format="DD/MM/YYYY" />
            </Form.Item>
            <Form.Item
              name="actual_range"
              label={t('sessions.edit.time')}
            >
              <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
            </Form.Item>
          </Space>
        </Form>
        {roster == null ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : roster.length === 0 ? (
          <Alert
            type="info"
            showIcon
            message={t('sessions.sheetEntry.noStudents')}
          />
        ) : (
          <>
            <Space wrap>
              <Button
                size="small"
                onClick={() =>
                  setMarks(
                    Object.fromEntries(
                      roster.map((r) => [r.student_id, 'PRESENT' as const]),
                    ),
                  )
                }
              >
                {t('attendance.allPresent')}
              </Button>
              <Text type="secondary">
                {t('attendance.counter', {
                  present: live.present,
                  absent: live.absent,
                  justified: live.justified,
                })}
              </Text>
            </Space>
            <Table<AttendanceDetail['roster'][number]>
              size="small"
              rowKey="student_id"
              dataSource={roster}
              pagination={false}
              scroll={{ y: 320 }}
              columns={[
                {
                  key: 'student',
                  title: t('attendance.student'),
                  dataIndex: 'full_name',
                  render: (v: string) => <span dir="auto">{v}</span>,
                },
                {
                  key: 'group',
                  title: t('attendance.group'),
                  dataIndex: 'group_name',
                  render: (v: string) => <span dir="auto">{v}</span>,
                },
                {
                  key: 'status',
                  title: t('timetable.detail.status'),
                  width: 190,
                  render: (_v, r) => (
                    <Segmented<StudentAttendanceStatus>
                      size="small"
                      value={marks[r.student_id] ?? 'PRESENT'}
                      onChange={(v) =>
                        setMarks((m) => ({ ...m, [r.student_id]: v }))
                      }
                      options={[
                        {
                          value: 'PRESENT',
                          label: t('attendance.statuses.PRESENT'),
                        },
                        {
                          value: 'ABSENT',
                          label: t('attendance.statuses.ABSENT'),
                        },
                        {
                          value: 'JUSTIFIE',
                          label: t('attendance.statuses.JUSTIFIE'),
                        },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}

/** Champs service → champs Form (les bornes horaires vivent en RangePicker). */
const FIELD_TO_FORM: Record<string, string> = {
  start_min: 'range',
  end_min: 'range',
  actual_start_min: 'actual_range',
  actual_end_min: 'actual_range',
};

export function SessionDrawer(props: {
  sessionId: number | null;
  rooms: Room[];
  professors: ProfessorRow[];
  onClose: () => void;
  /** Appelé après chaque mutation réussie (le parent recharge ses données). */
  onChanged: () => void;
}): React.JSX.Element {
  const { sessionId, rooms, professors, onClose, onChanged } = props;
  const { t } = useTranslation();

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailReq = useRef(0);

  const [mutating, setMutating] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<
    'REALISEE' | 'REPORTEE' | 'ANNULEE' | 'CORRECTIVE' | null
  >(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [refusal, setRefusal] = useState<PlacementConflict[] | null>(null);
  const [masterGroups, setMasterGroups] = useState<StudentGroupRow[]>([]);
  const [mmGroupId, setMmGroupId] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [statusForm] = Form.useForm();
  const [groupsForm] = Form.useForm();

  const openSession = useCallback(async (id: number): Promise<void> => {
    // Request-id : les réponses obsolètes sont ignorées — le drawer
    // affiche toujours la dernière séance demandée.
    const req = ++detailReq.current;
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
  }, []);

  useEffect(() => {
    if (sessionId != null) {
      void openSession(sessionId);
    } else {
      setDetail(null);
      setDetailLoading(false);
    }
  }, [sessionId, openSession]);

  /** minutes depuis minuit pour un dayjs (heure de début/fin). */
  const minOf = (d: Dayjs): number => d.hour() * 60 + d.minute();

  /**
   * Applique un `SessionEditResult` : succès → toast + `onChanged` +
   * callback ; refus BR-10 → Modal détaillée ; erreurs de validation →
   * surlignées dans le Form ; autre échec → toast erreur.
   */
  const applyEditResult = (
    res: SessionEditResult,
    okMessage: string,
    form?: FormInstance,
    onSuccess?: () => void,
  ): void => {
    if (res.ok) {
      void message.success(okMessage);
      onChanged();
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
      applyEditResult(res, t('sessions.edit.saved'), editForm, () => {
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
      applyEditResult(res, t('sessions.status.updated'), statusForm, () => {
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
      applyEditResult(res, t('sessions.groups.saved'), groupsForm, () => {
        setGroupsOpen(false);
        refreshDetail();
      });
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setMutating(false);
    }
  };

  // -- Feuille de présence (P14) — PDF via sessions:attendanceSheet, sur
  //    TOUTES les séances (la feuille sert pendant le cours ; la saisie
  //    nominative reste réservée aux séances réalisées) --

  const printSheet = async (): Promise<void> => {
    if (!detail) return;
    setPrinting(true);
    try {
      const res = await api().sessions.attendanceSheet(detail.session.id);
      if (res.ok) {
        if (res.data.cancelled) {
          void message.info(t('sessions.sheetCancelled'));
        } else {
          void message.success(t('sessions.sheetDone'));
        }
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setPrinting(false);
    }
  };

  // -- Suppression --

  const doDelete = async (): Promise<void> => {
    if (!detail) return;
    try {
      const res = await api().sessions.remove(detail.session.id);
      applyEditResult(res, t('sessions.delete.done'), undefined, () => {
        setDetail(null);
        onClose();
      });
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  return (
    <>
      <Drawer
        title={t('timetable.detail.title')}
        open={sessionId != null}
        onClose={onClose}
        width={480}
      >
        {detailLoading ? (
          <Skeleton active />
        ) : detail ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Actions P7b — BR-24 : les deux profils écrivent ; REALISEE
                verrouille Modifier/Supprimer (correction via Statut). */}
            <Space wrap>
              <Tooltip
                title={
                  detail.session.status === 'REALISEE'
                    ? t('sessions.edit.lockedRealisee')
                    : undefined
                }
              >
                <Button
                  icon={<EditOutlined />}
                  onClick={openEdit}
                  disabled={detail.session.status === 'REALISEE'}
                >
                  {t('sessions.edit.action')}
                </Button>
              </Tooltip>
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
              {/* P14 : feuille de présence PDF — toutes les séances. */}
              <Button
                icon={<PrinterOutlined />}
                loading={printing}
                onClick={() => void printSheet()}
              >
                {t('sessions.attendanceSheet')}
              </Button>
              {/* P17 : saisie groupée — PREVUE/REPORTEE seulement. */}
              {(detail.session.status === 'PREVUE' ||
                detail.session.status === 'REPORTEE') && (
                <Button
                  icon={<FileDoneOutlined />}
                  onClick={() => setSheetOpen(true)}
                >
                  {t('sessions.sheetEntry.action')}
                </Button>
              )}
              <Tooltip
                title={
                  detail.session.status === 'REALISEE'
                    ? t('sessions.edit.lockedRealisee')
                    : undefined
                }
              >
                <Popconfirm
                  title={t('sessions.delete.title')}
                  description={t('sessions.delete.confirm')}
                  okText={t('common.delete')}
                  cancelText={t('common.cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void doDelete()}
                >
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    disabled={detail.session.status === 'REALISEE'}
                  >
                    {t('sessions.delete.action')}
                  </Button>
                </Popconfirm>
              </Tooltip>
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
            {/* Présences (P9b) : uniquement sur une séance réalisée.
                key=session.id : remontée complète entre séances — pas
                d'état résiduel ni de roster périmé au submit. */}
            {detail.session.status === 'REALISEE' && (
              <AttendanceSection
                key={detail.session.id}
                sessionId={detail.session.id}
              />
            )}
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
              options={rooms
                .filter(
                  (r) =>
                    r.is_active === 1 || r.id === detail?.session.room.id,
                )
                .map((r) => ({
                  value: r.id,
                  label:
                    r.is_active === 1
                      ? r.name
                      : `${r.name} ${t('masterModules.inactiveSuffix')}`,
                }))}
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
                .filter(
                  (p) =>
                    p.is_active === 1 ||
                    p.id === detail?.session.professor.id,
                )
                .map((p) => ({
                  value: p.id,
                  label:
                    p.is_active === 1
                      ? p.full_name
                      : `${p.full_name} ${t('masterModules.inactiveSuffix')}`,
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
              options={masterGroups
                .filter((g) => g.id !== mmGroupId)
                .map((g) => ({
                  value: g.id,
                  label: g.name,
                }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Modal refus BR-10 — liste détaillée des conflits */}
      <SessionConflictsModal
        conflicts={refusal}
        onClose={() => setRefusal(null)}
      />

      {/* P17 — Modal « Saisir la feuille » (montée à l'ouverture :
          roster et marques frais à chaque fois). */}
      {sheetOpen && detail && (
        <SheetEntryModal
          detail={detail}
          onClose={() => setSheetOpen(false)}
          onDone={() => {
            onChanged();
            refreshDetail();
          }}
        />
      )}
    </>
  );
}
