/**
 * MastersPage — référentiel Masters : Table (recherche code/nom/filière,
 * filtre statut, compteurs) + Drawer formulaire + suppression protégée
 * BR-22 (refus chiffré → propose l'archivage).
 * Clic ligne → drawer « Fiche » à onglets : Infos (compteurs AD-7),
 * Modules (master-modules : rattacher/éditer/détacher, BR-22 sur les
 * séances liées), Groupes (ajouter/renommer/supprimer), Séances
 * (20 prochaines, statut coloré AD-7).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import { CrudTable } from '../components/CrudTable';
import { EntityDrawer } from '../components/EntityDrawer';
import {
  effectiveSessionStatus,
  type ApiResult,
  type ContextSemesters,
  type EffectiveSessionStatus,
  type GroupInput,
  type MasterDetail,
  type MasterInput,
  type MasterModuleInput,
  type MasterModuleRow,
  type MasterRow,
  type MasterSession,
  type MasterStatus,
  type Module,
  type ProfessorRow,
  type StudentGroupRow,
  type StudentRow,
} from '../../shared/types';

const { Title, Text } = Typography;

function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function fmtHM(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

const STATUS_COLORS: Record<EffectiveSessionStatus, string> = {
  PREVUE: 'blue',
  REALISEE: 'green',
  ANNULEE: 'red',
  REPORTEE: 'gold',
  NON_ENCORE_REALISEE: 'orange',
};

function StatusTag({
  status,
  date,
}: {
  status: MasterSession['status'];
  date: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const effective = effectiveSessionStatus(status, date, dayjs().format('YYYY-MM-DD'));
  return <Tag color={STATUS_COLORS[effective]}>{t(`sessionStatus.${effective}`)}</Tag>;
}

function SessionsTable({ sessions }: { sessions: MasterSession[] }): React.JSX.Element {
  const { t } = useTranslation();
  const columns: ColumnsType<MasterSession> = [
    {
      key: 'date',
      title: t('masters.session.date'),
      dataIndex: 'date',
      render: (v: string) => dayjs(v).format('ddd DD/MM/YYYY'),
    },
    {
      key: 'time',
      title: t('masters.session.time'),
      render: (_v, s) => `${minToHHMM(s.start_min)}–${minToHHMM(s.end_min)}`,
    },
    { key: 'module', title: t('masters.session.module'), dataIndex: 'module_name' },
    {
      key: 'professor',
      title: t('masters.session.professor'),
      dataIndex: 'professor_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      key: 'group',
      title: t('masters.session.group'),
      dataIndex: 'group_name',
      render: (v: string | null) =>
        v ? <span dir="auto">{v}</span> : <Text type="secondary">{t('groups.wholeMaster')}</Text>,
    },
    { key: 'room', title: t('masters.session.room'), dataIndex: 'room_name' },
    {
      key: 'status',
      title: t('masters.session.status'),
      render: (_v, s) => <StatusTag status={s.status} date={s.date} />,
    },
  ];
  return (
    <Table<MasterSession>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={sessions}
      pagination={{ pageSize: 15, hideOnSinglePage: true }}
      locale={{ emptyText: t('masters.session.empty') }}
    />
  );
}

/** Onglet Séances : bascule « À venir » (20 prochaines) / « Historique ». */
function SessionsPanel({
  upcoming,
  history,
}: {
  upcoming: MasterSession[];
  history: MasterSession[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'upcoming' | 'history'>('upcoming');
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as 'upcoming' | 'history')}
        options={[
          { value: 'upcoming', label: t('masters.session.upcoming') },
          {
            value: 'history',
            label: `${t('masters.session.history')} (${history.length})`,
          },
        ]}
      />
      <SessionsTable sessions={mode === 'upcoming' ? upcoming : history} />
    </Space>
  );
}

/**
 * Onglet Suivi : compteurs AD-7 + progression du volume global et
 * par module (heures réellement enseignées / volume prévu).
 */
function SuiviTab({
  master,
  modules,
}: {
  master: MasterDetail['master'];
  modules: MasterModuleRow[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const m = master;
  const pct =
    m.volume_prevu_min > 0
      ? Math.min(
          100,
          Math.round((m.heures_enseignees_min / m.volume_prevu_min) * 100),
        )
      : 0;
  const columns: ColumnsType<MasterModuleRow> = [
    {
      key: 'module',
      title: t('masterModules.module'),
      dataIndex: 'module_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      key: 'professor',
      title: t('masterModules.professor'),
      dataIndex: 'professor_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      key: 'planned',
      title: t('masters.suivi.planned'),
      dataIndex: 'planned_sessions',
      width: 90,
      align: 'center',
    },
    {
      key: 'done',
      title: t('masters.suivi.done'),
      dataIndex: 'done_sessions',
      width: 90,
      align: 'center',
    },
    {
      key: 'hoursDone',
      title: t('masters.suivi.hoursDone'),
      dataIndex: 'done_min',
      width: 110,
      align: 'center',
      render: (v: number) => fmtHM(v),
    },
    {
      key: 'volume',
      title: t('masters.suivi.volume'),
      dataIndex: 'volume_min',
      width: 90,
      align: 'center',
      render: (v: number) => fmtHM(v),
    },
    {
      key: 'progress',
      title: '',
      render: (_v, mm) => {
        const p =
          mm.volume_min > 0
            ? Math.min(100, Math.round((mm.done_min / mm.volume_min) * 100))
            : 0;
        return <Progress percent={p} size="small" />;
      },
    },
  ];
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap size="large">
        <Statistic
          title={t('masters.counters.realisees')}
          value={m.nb_realisees}
          valueStyle={{ color: '#16A34A' }}
        />
        <Statistic
          title={t('masters.counters.restantes')}
          value={m.nb_restantes}
        />
        <Statistic
          title={t('masters.counters.nonRealisees')}
          value={m.nb_non_realisees}
          valueStyle={m.nb_non_realisees > 0 ? { color: '#EA580C' } : undefined}
        />
        <Statistic
          title={t('masters.counters.annulees')}
          value={m.nb_annulees}
          valueStyle={m.nb_annulees > 0 ? { color: '#DC2626' } : undefined}
        />
        <Statistic
          title={t('masters.counters.reportees')}
          value={m.nb_reportees}
        />
        <Statistic
          title={t('masters.counters.heures')}
          value={fmtHM(m.heures_enseignees_min)}
        />
      </Space>
      <div>
        <Text type="secondary">{t('masters.suivi.progress')}</Text>
        <Progress
          percent={pct}
          format={() =>
            t('masters.suivi.progressText', {
              done: fmtHM(m.heures_enseignees_min),
              total: fmtHM(m.volume_prevu_min),
            })
          }
        />
      </div>
      <Table<MasterModuleRow>
        size="small"
        rowKey="id"
        title={() => <Text strong>{t('masters.suivi.perModule')}</Text>}
        columns={columns}
        dataSource={modules}
        pagination={false}
      />
    </Space>
  );
}

// --- Onglet Modules (master_modules) ------------------------------------------

interface ModuleFormValues {
  module_id: number;
  semester_id: number;
  professor_id: number;
  student_group_id?: number | null;
  volume_min: number;
  session_duration_min: number;
  planned_sessions: number;
  sched_start: dayjs.Dayjs;
  sched_end: dayjs.Dayjs;
  distribution_rule?: string | null;
}

const MM_FIELD_NAMES = [
  'module_id',
  'semester_id',
  'professor_id',
  'student_group_id',
  'volume_min',
  'session_duration_min',
  'planned_sessions',
  'sched_start',
  'sched_end',
  'distribution_rule',
];

function ModulesTab({
  masterId,
  academicYearId,
  groups,
  rows,
  refs,
  onChanged,
}: {
  masterId: number;
  /** Année du master — le Select semestre est restreint à cette année. */
  academicYearId: number;
  groups: StudentGroupRow[];
  rows: MasterModuleRow[];
  refs: {
    modules: Module[];
    professors: ProfessorRow[];
    semesters: ContextSemesters['semesters'];
    academicYears: ContextSemesters['academicYears'];
  };
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MasterModuleRow | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);

  const openAttach = (): void => {
    setEditing(null);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openEdit = (row: MasterModuleRow): void => {
    setEditing(row);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const submit = async (values: ModuleFormValues): Promise<ApiResult<unknown>> => {
    const input: MasterModuleInput = {
      module_id: values.module_id,
      semester_id: values.semester_id,
      professor_id: values.professor_id,
      student_group_id: values.student_group_id ?? null,
      volume_min: values.volume_min,
      session_duration_min: values.session_duration_min,
      planned_sessions: values.planned_sessions,
      sched_start: values.sched_start.format('YYYY-MM-DD'),
      sched_end: values.sched_end.format('YYYY-MM-DD'),
      distribution_rule: values.distribution_rule?.trim() || null,
      // Le drapeau « fixé » se gère par le Switch de la table, pas par
      // le formulaire : en édition on renvoie la valeur courante.
      is_fixed: editing?.is_fixed === 1,
    };
    const res = editing
      ? await api().masters.updateModule(editing.id, input)
      : await api().masters.attachModule(masterId, input);
    if (res.ok) {
      void message.success(t(editing ? 'masterModules.updated' : 'masterModules.attached'));
      onChanged();
    }
    return res;
  };

  /** Bascule « fixé » : update complet (le service conserve les autres
   *  champs via COALESCE, mais on renvoie l'intégralité de la ligne). */
  const toggleFixed = async (row: MasterModuleRow): Promise<void> => {
    const res = await api().masters.updateModule(row.id, {
      module_id: row.module_id,
      semester_id: row.semester_id,
      professor_id: row.professor_id,
      student_group_id: row.student_group_id ?? null,
      volume_min: row.volume_min,
      session_duration_min: row.session_duration_min,
      planned_sessions: row.planned_sessions,
      sched_start: row.sched_start,
      sched_end: row.sched_end,
      distribution_rule: row.distribution_rule,
      is_fixed: row.is_fixed !== 1,
    });
    if (res.ok) {
      void message.success(t('masterModules.fixedToggled'));
      onChanged();
    } else {
      Modal.error({ title: t('masterModules.fixed'), content: res.error });
    }
  };

  const confirmDetach = (row: MasterModuleRow): void => {
    Modal.confirm({
      title: t('masterModules.detachTitle'),
      content: t('masterModules.detachConfirm', { name: row.module_name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().masters.detachModule(row.id);
        if (res.ok) {
          void message.success(t('masterModules.detached'));
          onChanged();
        } else {
          Modal.error({ title: t('masterModules.detachTitle'), content: res.error });
        }
      },
    });
  };

  const columns: ColumnsType<MasterModuleRow> = [
    {
      key: 'module',
      title: t('masterModules.module'),
      render: (_v, r) => (
        <Space size={4} direction="vertical">
          <span dir="auto">{r.module_name}</span>
          <Text type="secondary">{r.module_code}</Text>
        </Space>
      ),
    },
    {
      key: 'professor',
      title: t('masterModules.professor'),
      dataIndex: 'professor_name',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    { key: 'semester', title: t('masterModules.semester'), dataIndex: 'semester_label', width: 90 },
    {
      key: 'group',
      title: t('masterModules.group'),
      render: (_v, r) =>
        r.group_name ? (
          <span dir="auto">{r.group_name}</span>
        ) : (
          <Text type="secondary">{t('groups.wholeMaster')}</Text>
        ),
    },
    {
      key: 'volume',
      title: t('masterModules.volumeMin'),
      dataIndex: 'volume_min',
      width: 110,
      render: (v: number) => fmtHM(v),
    },
    {
      key: 'sessions',
      title: t('masterModules.actualSessions'),
      width: 90,
      render: (_v, r) => `${r.nb_seances}/${r.planned_sessions}`,
    },
    {
      key: 'period',
      title: t('masterModules.period'),
      render: (_v, r) => (
        <Text type="secondary">
          {r.sched_start} → {r.sched_end}
        </Text>
      ),
    },
    {
      key: 'fixed',
      title: t('masterModules.fixed'),
      width: 110,
      render: (_v, r) => (
        <Space size={6}>
          {r.is_fixed === 1 && <Tag color="gold">{t('masterModules.fixed')}</Tag>}
          <Switch
            size="small"
            checked={r.is_fixed === 1}
            onChange={() => void toggleFixed(r)}
            aria-label={t('masterModules.fixed')}
          />
        </Space>
      ),
    },
    {
      key: '_actions',
      title: t('common.actions'),
      width: 100,
      render: (_v, r) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            aria-label={t('common.edit')}
            onClick={() => openEdit(r)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            aria-label={t('common.delete')}
            onClick={() => confirmDetach(r)}
          />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Table<MasterModuleRow>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t('masterModules.empty') }}
      />
      <Button type="primary" icon={<PlusOutlined />} onClick={openAttach}>
        {t('masterModules.attach')}
      </Button>
      <EntityDrawer<ModuleFormValues>
        key={drawerKey}
        open={drawerOpen}
        title={t(editing ? 'masterModules.editTitle' : 'masterModules.attachTitle')}
        initialValues={
          editing
            ? {
                module_id: editing.module_id,
                semester_id: editing.semester_id,
                professor_id: editing.professor_id,
                student_group_id: editing.student_group_id,
                volume_min: editing.volume_min,
                session_duration_min: editing.session_duration_min,
                planned_sessions: editing.planned_sessions,
                sched_start: dayjs(editing.sched_start),
                sched_end: dayjs(editing.sched_end),
                distribution_rule: editing.distribution_rule,
              }
            : undefined
        }
        onSubmit={submit}
        onClose={() => setDrawerOpen(false)}
        fieldNames={MM_FIELD_NAMES}
      >
        <Form.Item
          name="module_id"
          label={t('masterModules.module')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={refs.modules.map((m) => ({
              value: m.id,
              label: `${m.code} — ${m.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="professor_id"
          label={t('masterModules.professor')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            options={refs.professors
              // Profs actifs uniquement ; le prof déjà rattaché (inactif)
              // reste sélectionnable, marqué « (désactivé) ».
              .filter((p) => p.is_active === 1 || p.id === editing?.professor_id)
              .map((p) => ({
                value: p.id,
                label:
                  p.is_active === 1
                    ? p.full_name
                    : `${p.full_name} ${t('masterModules.inactiveSuffix')}`,
              }))}
          />
        </Form.Item>
        <Form.Item
          name="semester_id"
          label={t('masterModules.semester')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select
            options={refs.semesters
              .filter((s) => s.academic_year_id === academicYearId)
              .map((s) => {
                const year = refs.academicYears.find(
                  (y) => y.id === s.academic_year_id,
                );
                return {
                  value: s.id,
                  label: year ? `${s.label} · ${year.label}` : s.label,
                };
              })}
          />
        </Form.Item>
        <Form.Item name="student_group_id" label={t('masterModules.group')}>
          <Select
            allowClear
            placeholder={t('groups.wholeMaster')}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
        </Form.Item>
        <Form.Item
          name="volume_min"
          label={t('masterModules.volumeMin')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="session_duration_min"
          label={t('masterModules.sessionDuration')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <InputNumber min={1} max={480} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="planned_sessions"
          label={t('masterModules.plannedSessions')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="sched_start"
          label={t('masterModules.schedStart')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="sched_end"
          label={t('masterModules.schedEnd')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </EntityDrawer>
    </Space>
  );
}

// --- Registre étudiants d'un groupe (P9b — saisie manuelle pré-import) ---------

/**
 * Sous-liste des étudiants d'un groupe (fiche Master → Groupes) :
 * ajout minimal (nom obligatoire, external_id optionnel — clé d'import
 * Phase I) et suppression protégée BR-22 (refus chiffré si des présences
 * nominatives référencent l'étudiant).
 */
function GroupStudents({
  group,
  onChanged,
}: {
  group: StudentGroupRow;
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [form] = Form.useForm<{ full_name: string; external_id?: string }>();

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api().students.list(group.id);
      if (res.ok) setStudents(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  }, [group.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (values: {
    full_name: string;
    external_id?: string;
  }): Promise<void> => {
    const res = await api().students.add(group.id, {
      full_name: values.full_name,
      external_id: values.external_id?.trim() || null,
    });
    if (res.ok) {
      void message.success(t('students.added'));
      form.resetFields();
      void load();
      onChanged(); // linkedCount du groupe + compteurs du master bougent
    } else {
      if (res.fields) {
        form.setFields(
          res.fields.map((f) => ({ name: f.field, errors: [f.message] })) as never,
        );
      }
      void message.error(res.error);
    }
  };

  const confirmRemove = (s: StudentRow): void => {
    Modal.confirm({
      title: t('students.removeTitle'),
      content: t('students.removeConfirm', { name: s.full_name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().students.remove(s.id);
        if (res.ok) {
          void message.success(t('students.removed'));
          void load();
          onChanged();
        } else {
          // Refus BR-22 chiffré (présences nominatives liées).
          Modal.error({ title: t('students.removeTitle'), content: res.error });
        }
      },
    });
  };

  return (
    <div style={{ marginTop: 4 }}>
      {students == null ? null : students.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('students.empty')}
        </Text>
      ) : (
        students.map((s) => (
          <div
            key={s.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '2px 0',
            }}
          >
            <Space size={8}>
              <span dir="auto">{s.full_name}</span>
              {s.external_id != null && (
                <Text type="secondary" style={{ fontSize: 11 }} dir="auto">
                  {s.external_id}
                </Text>
              )}
            </Space>
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('common.delete')}
              onClick={() => confirmRemove(s)}
            />
          </div>
        ))
      )}
      <Form
        form={form}
        layout="inline"
        onFinish={(v) => void submit(v)}
        style={{ marginTop: 6 }}
      >
        <Form.Item
          name="full_name"
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input
            dir="auto"
            size="small"
            placeholder={t('students.name')}
            style={{ width: 200 }}
          />
        </Form.Item>
        <Form.Item name="external_id">
          <Input
            dir="auto"
            size="small"
            placeholder={t('students.externalId')}
            style={{ width: 140 }}
          />
        </Form.Item>
        <Form.Item>
          <Button
            size="small"
            type="primary"
            htmlType="submit"
            icon={<PlusOutlined />}
          >
            {t('students.add')}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}

// --- Onglet Groupes (student_group) -------------------------------------------

function GroupsTab({
  masterId,
  groups,
  onChanged,
}: {
  masterId: number;
  groups: StudentGroupRow[];
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ name: string; size?: number | null }>();
  const [renaming, setRenaming] = useState<StudentGroupRow | null>(null);
  const [renameForm] = Form.useForm<{ name: string; size?: number | null }>();

  const submit = async (values: { name: string; size?: number | null }): Promise<void> => {
    const input: GroupInput = { name: values.name, size: values.size ?? null };
    const res = await api().masters.addGroup(masterId, input);
    if (res.ok) {
      void message.success(t('groups.added'));
      form.resetFields();
      onChanged();
    } else {
      if (res.fields) {
        form.setFields(
          res.fields.map((f) => ({ name: f.field, errors: [f.message] })) as never,
        );
      }
      void message.error(res.error);
    }
  };

  const submitRename = async (): Promise<void> => {
    if (!renaming) return;
    const values = await renameForm.validateFields();
    const input: GroupInput = { name: values.name, size: values.size ?? null };
    const res = await api().masters.renameGroup(renaming.id, input);
    if (res.ok) {
      void message.success(t('groups.renamed'));
      setRenaming(null);
      onChanged();
    } else {
      if (res.fields) {
        renameForm.setFields(
          res.fields.map((f) => ({ name: f.field, errors: [f.message] })) as never,
        );
      }
      void message.error(res.error);
    }
  };

  const confirmRemove = (g: StudentGroupRow): void => {
    Modal.confirm({
      title: t('groups.removeTitle'),
      content: t('groups.removeConfirm', { name: g.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().masters.removeGroup(g.id);
        if (res.ok) {
          void message.success(t('groups.removed'));
          onChanged();
        } else {
          Modal.error({ title: t('groups.removeTitle'), content: res.error });
        }
      },
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <List<StudentGroupRow>
        size="small"
        dataSource={groups}
        locale={{ emptyText: t('groups.empty') }}
        renderItem={(g) => (
          <List.Item
            actions={[
              <Button
                key="edit"
                size="small"
                type="text"
                icon={<EditOutlined />}
                aria-label={t('common.edit')}
                onClick={() => {
                  setRenaming(g);
                  renameForm.setFieldsValue({ name: g.name, size: g.size });
                }}
              />,
              <Button
                key="del"
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                aria-label={t('common.delete')}
                onClick={() => confirmRemove(g)}
              />,
            ]}
          >
            <div style={{ width: '100%' }}>
              <Space>
                <span dir="auto">{g.name}</span>
                {g.size != null && <Text type="secondary">({g.size})</Text>}
                {g.linkedCount > 0 && (
                  <Tag>
                    {t('groups.linked')} : {g.linkedCount}
                  </Tag>
                )}
              </Space>
              {/* Registre étudiants du groupe (P9b — mini-CRUD pré-import). */}
              <GroupStudents group={g} onChanged={onChanged} />
            </div>
          </List.Item>
        )}
      />
      <Form form={form} layout="inline" onFinish={(v) => void submit(v)}>
        <Form.Item name="name" rules={[{ required: true, message: t('common.required') }]}>
          <Input dir="auto" placeholder={t('groups.name')} style={{ width: 220 }} />
        </Form.Item>
        <Form.Item name="size">
          <InputNumber min={1} placeholder={t('groups.size')} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
            {t('groups.add')}
          </Button>
        </Form.Item>
      </Form>
      <Modal
        open={renaming !== null}
        title={t('groups.renameTitle')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={() => void submitRename()}
        onCancel={() => setRenaming(null)}
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('groups.name')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Input dir="auto" />
          </Form.Item>
          <Form.Item name="size" label={t('groups.size')}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

// --- Page ----------------------------------------------------------------------

interface MasterFormValues {
  code: string;
  name: string;
  filiere?: string | null;
  department?: string | null;
  responsible_name?: string | null;
  academic_year_id: number;
  semester_id?: number | null;
  status?: MasterStatus;
  temps_amenage?: boolean;
}

const MASTER_FIELD_NAMES = [
  'code',
  'name',
  'filiere',
  'department',
  'responsible_name',
  'academic_year_id',
  'semester_id',
  'status',
  'temps_amenage',
];

export function MastersPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<MasterStatus | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MasterRow | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  const [detail, setDetail] = useState<MasterDetail | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  // P17 — feuille de présence hebdo : semaine choisie (défaut : courante).
  const [weekSheetDay, setWeekSheetDay] = useState(dayjs());
  const [weekSheetLoading, setWeekSheetLoading] = useState(false);
  const [refModules, setRefModules] = useState<Module[]>([]);
  const [refProfessors, setRefProfessors] = useState<ProfessorRow[]>([]);
  const [context, setContext] = useState<ContextSemesters>({
    academicYears: [],
    semesters: [],
  });

  const reload = useCallback(async (status?: MasterStatus): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().masters.list({ status: status ?? 'TOUS' });
      if (res.ok) setRows(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadDetail = useCallback(async (id: number): Promise<void> => {
    try {
      const res = await api().masters.get(id);
      if (res.ok) setDetail(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!hasApi()) return;
    // Référentiels des Select (module/prof/semestre/année) — erreurs visibles.
    const notify = (err: unknown): void => void message.error(errorMessage(err));
    void api()
      .modules.list()
      .then((res) => (res.ok ? setRefModules(res.data) : notify(res)))
      .catch(notify);
    void api()
      .professors.list()
      .then((res) => (res.ok ? setRefProfessors(res.data) : notify(res)))
      .catch(notify);
    void api()
      .contextSemesters()
      .then((res) => (res.ok ? setContext(res.data) : notify(res)))
      .catch(notify);
  }, [reload]);

  const openCreate = (): void => {
    setEditing(null);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openEdit = (row: MasterRow): void => {
    setEditing(row);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openDetail = (row: MasterRow): void => {
    // Purge la fiche précédente : pas de données périmées ni de mutation
    // sur le mauvais master pendant le chargement.
    setDetail(null);
    setDetailId(row.id);
    setDetailOpen(true);
    setWeekSheetDay(dayjs()); // semaine courante par défaut à l'ouverture
    void reloadDetail(row.id);
  };

  /** P17 — PDF A4 paysage : `sessions:weekSheet` (un jour → lundi côté main). */
  const printWeekSheet = async (): Promise<void> => {
    if (detailId == null) return;
    setWeekSheetLoading(true);
    try {
      const res = await api().sessions.weekSheet({
        master_id: detailId,
        week_start: weekSheetDay.format('YYYY-MM-DD'),
      });
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
      setWeekSheetLoading(false);
    }
  };

  const submit = async (values: MasterFormValues): Promise<ApiResult<unknown>> => {
    const input: MasterInput = {
      code: values.code,
      name: values.name,
      filiere: values.filiere?.trim() || null,
      department: values.department?.trim() || null,
      responsible_name: values.responsible_name?.trim() || null,
      academic_year_id: values.academic_year_id,
      semester_id: values.semester_id ?? null,
      status: values.status ?? 'ACTIF',
      temps_amenage: values.temps_amenage === true,
    };
    const res = editing
      ? await api().masters.update(editing.id, input)
      : await api().masters.create(input);
    if (res.ok) {
      void message.success(t(editing ? 'masters.updated' : 'masters.created'));
      void reload(statusFilter);
    }
    return res;
  };

  const toggleStatus = async (row: MasterRow): Promise<void> => {
    const next: MasterStatus = row.status === 'ACTIF' ? 'ARCHIVE' : 'ACTIF';
    const res = await api().masters.setStatus(row.id, next);
    if (res.ok) {
      void message.success(t(res.data.status === 'ACTIF' ? 'masters.activated' : 'masters.archived'));
      void reload(statusFilter);
    } else {
      void message.error(errorMessage(res));
    }
  };

  /** BR-22 : suppression refusée (données liées) → propose l'archivage. */
  const showDeleteRefused = (row: MasterRow, serverError?: string): void => {
    Modal.confirm({
      title: t('masters.deleteRefused'),
      content: serverError ?? t('masters.refusedBody', { count: row.linkedCount }),
      okText: t('masters.archive'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().masters.setStatus(row.id, 'ARCHIVE');
        if (res.ok) {
          void message.success(t('masters.archived'));
          void reload(statusFilter);
        } else {
          void message.error(errorMessage(res));
        }
      },
    });
  };

  const confirmDelete = (row: MasterRow): void => {
    if (row.linkedCount > 0) {
      showDeleteRefused(row);
      return;
    }
    Modal.confirm({
      title: t('masters.deleteTitle'),
      content: t('masters.deleteConfirmFree', { name: row.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().masters.remove(row.id);
        if (res.ok) {
          void message.success(t('masters.deleted'));
          void reload(statusFilter);
        } else {
          showDeleteRefused(row, res.error);
        }
      },
    });
  };

  const columns: ColumnsType<MasterRow> = [
    {
      key: 'code',
      title: t('masters.code'),
      dataIndex: 'code',
      width: 100,
      sorter: (a, b) => a.code.localeCompare(b.code, 'fr'),
    },
    {
      key: 'name',
      title: t('masters.name'),
      dataIndex: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name, 'fr'),
      render: (v: string, row) => (
        <Space size="small">
          <span dir="auto">{v}</span>
          {row.is_demo === 1 && <Tag color="orange">DÉMO</Tag>}
        </Space>
      ),
    },
    {
      key: 'filiere',
      title: t('masters.filiere'),
      dataIndex: 'filiere',
      render: (v: string | null) => (v ? <span dir="auto">{v}</span> : '—'),
    },
    {
      key: 'nb_modules',
      title: t('masters.nbModules'),
      dataIndex: 'nb_modules',
      sorter: (a, b) => a.nb_modules - b.nb_modules,
      width: 100,
    },
    {
      key: 'nb_groupes',
      title: t('masters.nbGroupes'),
      dataIndex: 'nb_groupes',
      sorter: (a, b) => a.nb_groupes - b.nb_groupes,
      width: 100,
    },
    {
      key: 'nb_seances',
      title: t('masters.nbSeances'),
      dataIndex: 'nb_seances',
      sorter: (a, b) => a.nb_seances - b.nb_seances,
      width: 100,
    },
    {
      key: 'volume_prevu_min',
      title: t('masters.volumePrevu'),
      dataIndex: 'volume_prevu_min',
      sorter: (a, b) => a.volume_prevu_min - b.volume_prevu_min,
      width: 120,
      render: (v: number) => fmtHM(v),
    },
    {
      key: 'status',
      title: t('masters.status'),
      filters: [
        { text: t('masters.statusActif'), value: 'ACTIF' },
        { text: t('masters.statusArchive'), value: 'ARCHIVE' },
      ],
      onFilter: (value, row) => row.status === value,
      width: 160,
      render: (_v, row) => (
        <Space size={4} wrap>
          {row.status === 'ACTIF' ? (
            <Tag color="green">{t('masters.statusActif')}</Tag>
          ) : (
            <Tag>{t('masters.statusArchive')}</Tag>
          )}
          {/* P14 : master payant (service économique différé). */}
          {row.temps_amenage === 1 && (
            <Tag color="blue">{t('masters.tempsAmenageTag')}</Tag>
          )}
        </Space>
      ),
    },
  ];

  const m = detail?.master;
  const currentYear = context.academicYears.find((y) => y.is_current === 1);

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('masters.title')}
      </Title>
      <CrudTable<MasterRow>
        rows={rows}
        loading={loading}
        columns={columns}
        searchKeys={['code', 'name', 'filiere']}
        dimInactive
        isRowActive={(row) => row.status === 'ACTIF'}
        onEdit={openEdit}
        onDelete={confirmDelete}
        onToggleActive={toggleStatus}
        onRowClick={openDetail}
        toolbar={
          <Space>
            <Select
              allowClear
              placeholder={t('masters.status')}
              style={{ width: 160 }}
              value={statusFilter}
              options={[
                { value: 'ACTIF', label: t('masters.statusActif') },
                { value: 'ARCHIVE', label: t('masters.statusArchive') },
              ]}
              onChange={(v) => {
                setStatusFilter(v as MasterStatus | undefined);
                void reload(v as MasterStatus | undefined);
              }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              {t('common.create')}
            </Button>
          </Space>
        }
      />
      <EntityDrawer<MasterFormValues>
        key={drawerKey}
        open={drawerOpen}
        title={t(editing ? 'masters.editTitle' : 'masters.createTitle')}
        initialValues={
          editing
            ? {
                code: editing.code,
                name: editing.name,
                filiere: editing.filiere,
                department: editing.department,
                responsible_name: editing.responsible_name,
                academic_year_id: editing.academic_year_id,
                semester_id: editing.semester_id,
                status: editing.status,
                temps_amenage: editing.temps_amenage === 1,
              }
            : {
                academic_year_id: currentYear?.id,
                status: 'ACTIF',
                temps_amenage: false,
              }
        }
        onSubmit={submit}
        onClose={() => setDrawerOpen(false)}
        fieldNames={MASTER_FIELD_NAMES}
      >
        <Form.Item
          name="code"
          label={t('masters.code')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('masters.name')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input dir="auto" />
        </Form.Item>
        <Form.Item name="filiere" label={t('masters.filiere')}>
          <Input dir="auto" />
        </Form.Item>
        <Form.Item name="department" label={t('masters.department')}>
          <Input dir="auto" />
        </Form.Item>
        <Form.Item name="responsible_name" label={t('masters.responsible')}>
          <Input dir="auto" />
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(prev, cur) => prev.academic_year_id !== cur.academic_year_id}
        >
          {(form) => (
            <>
              <Form.Item
                name="academic_year_id"
                label={t('masters.academicYear')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <Select
                  options={context.academicYears.map((y) => ({
                    value: y.id,
                    label: y.label,
                  }))}
                  // Changer d'année invalide le semestre choisi (il
                  // appartient à l'ancienne année) → reset explicite.
                  onChange={() =>
                    form.setFieldsValue({ semester_id: null })
                  }
                />
              </Form.Item>
              <Form.Item name="semester_id" label={t('masters.semester')}>
                <Select
                  allowClear
                  options={context.semesters
                    .filter(
                      (s) =>
                        s.academic_year_id ===
                        form.getFieldValue('academic_year_id'),
                    )
                    .map((s) => ({ value: s.id, label: s.label }))}
                />
              </Form.Item>
            </>
          )}
        </Form.Item>
        <Form.Item name="status" label={t('masters.status')}>
          <Select
            options={[
              { value: 'ACTIF', label: t('masters.statusActif') },
              { value: 'ARCHIVE', label: t('masters.statusArchive') },
            ]}
          />
        </Form.Item>
        {/* P14 : master payant — badge « Temps aménagé », filtrage du
            futur rapport service économique (aucun traitement en v1). */}
        <Form.Item name="temps_amenage" valuePropName="checked">
          <Checkbox>{t('masters.tempsAmenage')}</Checkbox>
        </Form.Item>
      </EntityDrawer>
      <Drawer
        key={detailId ?? 'closed'}
        open={detailOpen}
        width={760}
        destroyOnHidden
        title={
          m ? (
            <span dir="auto">{t('masters.detailTitle', { name: m.name })}</span>
          ) : (
            t('common.loading')
          )
        }
        onClose={() => {
          setDetailOpen(false);
          void reload(statusFilter); // compteurs/groupes potentiellement modifiés
        }}
      >
        {detail && m && detailId !== null && (
          <Tabs
            items={[
              {
                key: 'infos',
                label: t('masters.tabs.infos'),
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label={t('masters.code')}>
                        {m.code}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.filiere')}>
                        <span dir="auto">{m.filiere ?? '—'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.department')}>
                        <span dir="auto">{m.department ?? '—'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.responsible')}>
                        <span dir="auto">{m.responsible_name ?? '—'}</span>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.academicYear')}>
                        {m.academic_year_label}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.semester')}>
                        {m.semester_label ?? '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label={t('masters.status')}>
                        <Space size={4} wrap>
                          {m.status === 'ACTIF' ? (
                            <Tag color="green">{t('masters.statusActif')}</Tag>
                          ) : (
                            <Tag>{t('masters.statusArchive')}</Tag>
                          )}
                          {m.temps_amenage === 1 && (
                            <Tag color="blue">
                              {t('masters.tempsAmenageTag')}
                            </Tag>
                          )}
                        </Space>
                      </Descriptions.Item>
                    </Descriptions>
                    <Space wrap size="large">
                      <Statistic
                        title={t('masters.counters.realisees')}
                        value={m.nb_realisees}
                      />
                      <Statistic
                        title={t('masters.counters.restantes')}
                        value={m.nb_restantes}
                      />
                      <Statistic
                        title={t('masters.counters.nonRealisees')}
                        value={m.nb_non_realisees}
                      />
                      <Statistic
                        title={t('masters.counters.annulees')}
                        value={m.nb_annulees}
                      />
                      <Statistic
                        title={t('masters.counters.reportees')}
                        value={m.nb_reportees}
                      />
                      <Statistic
                        title={t('masters.counters.heures')}
                        value={fmtHM(m.heures_enseignees_min)}
                      />
                    </Space>
                  </Space>
                ),
              },
              {
                key: 'suivi',
                label: t('masters.tabs.suivi'),
                children: (
                  <SuiviTab master={m} modules={detail.modules} />
                ),
              },
              {
                key: 'modules',
                label: t('masters.tabs.modules'),
                children: (
                  <ModulesTab
                    masterId={detailId}
                    academicYearId={m.academic_year_id}
                    groups={detail.groups}
                    rows={detail.modules}
                    refs={{
                      modules: refModules,
                      professors: refProfessors,
                      semesters: context.semesters,
                      academicYears: context.academicYears,
                    }}
                    onChanged={() => void reloadDetail(detailId)}
                  />
                ),
              },
              {
                key: 'groups',
                label: t('masters.tabs.groups'),
                children: (
                  <GroupsTab
                    masterId={detailId}
                    groups={detail.groups}
                    onChanged={() => void reloadDetail(detailId)}
                  />
                ),
              },
              {
                key: 'sessions',
                label: t('masters.tabs.sessions'),
                children: (
                  <Space
                    direction="vertical"
                    size="middle"
                    style={{ width: '100%' }}
                  >
                    {/* P17 : feuille de présence hebdo du master (PDF paysage). */}
                    <Space wrap>
                      <Text type="secondary">
                        {t('masters.weekSheetWeek')}
                      </Text>
                      <DatePicker
                        picker="week"
                        allowClear={false}
                        value={weekSheetDay}
                        onChange={(v) => {
                          if (v) setWeekSheetDay(v);
                        }}
                      />
                      <Button
                        icon={<PrinterOutlined />}
                        loading={weekSheetLoading}
                        onClick={() => void printWeekSheet()}
                      >
                        {t('masters.weekSheet')}
                      </Button>
                    </Space>
                    <SessionsPanel
                      upcoming={detail.upcoming}
                      history={detail.history}
                    />
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </Card>
  );
}
