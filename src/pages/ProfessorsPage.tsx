/**
 * ProfessorsPage — référentiel Professeurs : Table (recherche nom/réf/email,
 * filtre actif, compteurs de suivi) + Drawer formulaire + suppression
 * protégée BR-22 (refus chiffré → propose la désactivation).
 * Clic ligne → drawer « Fiche de suivi » à onglets : Séances (20 prochaines,
 * statut coloré AD-7), Disponibilités, Absences (séances impactées, BR-17 :
 * aucune annulation automatique), Compteurs.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  List,
  Modal,
  Radio,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  TimePicker,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import { CrudTable } from '../components/CrudTable';
import { EntityDrawer } from '../components/EntityDrawer';
import { SessionConflictsModal } from '../components/SessionDrawer';
import {
  ABSENCE_DECISIONS,
  effectiveSessionStatus,
  type AbsenceDecisionKind,
  type AbsenceDetail,
  type AbsenceDetailSession,
  type AbsenceInput,
  type AbsenceListRow,
  type AbsenceResolution,
  type ApiResult,
  type AvailabilityInput,
  type AvailabilityRow,
  type EffectiveSessionStatus,
  type ImpactedSession,
  type PlacementConflict,
  type ProfessorDetail,
  type ProfessorInput,
  type ProfessorRow,
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

function StatusTag({ status, date }: { status: ImpactedSession['status']; date: string }): React.JSX.Element {
  const { t } = useTranslation();
  const effective = effectiveSessionStatus(status, date, dayjs().format('YYYY-MM-DD'));
  return <Tag color={STATUS_COLORS[effective]}>{t(`sessionStatus.${effective}`)}</Tag>;
}

function SessionsTable({ sessions, emptyText }: { sessions: ImpactedSession[]; emptyText: string }): React.JSX.Element {
  const { t } = useTranslation();
  const columns: ColumnsType<ImpactedSession> = [
    {
      key: 'date',
      title: t('professors.session.date'),
      dataIndex: 'date',
      render: (v: string) => dayjs(v).format('ddd DD/MM/YYYY'),
    },
    {
      key: 'time',
      title: t('professors.session.time'),
      render: (_v, s) => `${minToHHMM(s.start_min)}–${minToHHMM(s.end_min)}`,
    },
    { key: 'module', title: t('professors.session.module'), dataIndex: 'module_name' },
    { key: 'master', title: t('professors.session.master'), dataIndex: 'master_name' },
    { key: 'room', title: t('professors.session.room'), dataIndex: 'room_name' },
    {
      key: 'status',
      title: t('professors.session.status'),
      render: (_v, s) => <StatusTag status={s.status} date={s.date} />,
    },
  ];
  return (
    <Table<ImpactedSession>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={sessions}
      pagination={false}
      locale={{ emptyText }}
    />
  );
}

function AvailabilitiesTab({
  professorId,
  availabilities,
  onChanged,
}: {
  professorId: number;
  availabilities: AvailabilityRow[];
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<{
    weekday: number;
    kind: 'DISPO' | 'INDISPO';
    start: dayjs.Dayjs;
    end: dayjs.Dayjs;
    range?: [dayjs.Dayjs, dayjs.Dayjs] | null;
  }>();
  const weekdays = t('weekdays', { returnObjects: true }) as unknown as string[];

  const submit = async (values: {
    weekday: number;
    kind: 'DISPO' | 'INDISPO';
    start: dayjs.Dayjs;
    end: dayjs.Dayjs;
    range?: [dayjs.Dayjs, dayjs.Dayjs] | null;
  }): Promise<void> => {
    const input: AvailabilityInput = {
      weekday: values.weekday,
      kind: values.kind,
      start_min: values.start.hour() * 60 + values.start.minute(),
      end_min: values.end.hour() * 60 + values.end.minute(),
      effective_from: values.range?.[0]?.format('YYYY-MM-DD') ?? null,
      effective_to: values.range?.[1]?.format('YYYY-MM-DD') ?? null,
    };
    const res = await api().professors.availability.add(professorId, input);
    if (res.ok) {
      void message.success(t('professors.availability.added'));
      form.resetFields();
      onChanged();
    } else {
      if (res.fields) {
        const map: Record<string, string> = {
          weekday: 'weekday',
          kind: 'kind',
          start_min: 'start',
          end_min: 'end',
          effective_from: 'range',
          effective_to: 'range',
        };
        form.setFields(
          res.fields
            .filter((f) => map[f.field])
            .map((f) => ({ name: map[f.field], errors: [f.message] })) as never,
        );
      }
      void message.error(res.error);
    }
  };

  const remove = async (id: number): Promise<void> => {
    const res = await api().professors.availability.remove(id);
    if (res.ok) {
      void message.success(t('professors.availability.removed'));
      onChanged();
    } else {
      void message.error(errorMessage(res));
    }
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <List<AvailabilityRow>
        size="small"
        dataSource={availabilities}
        locale={{ emptyText: t('professors.availability.empty') }}
        renderItem={(a) => (
          <List.Item
            actions={[
              <Button
                key="del"
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                aria-label={t('common.delete')}
                onClick={() => void remove(a.id)}
              />,
            ]}
          >
            <Space>
              <Tag color={a.kind === 'DISPO' ? 'green' : 'red'}>
                {t(`professors.availability.${a.kind === 'DISPO' ? 'dispo' : 'indispo'}`)}
              </Tag>
              <Text>
                {weekdays[a.weekday]} {minToHHMM(a.start_min)}–{minToHHMM(a.end_min)}
              </Text>
              {(a.effective_from || a.effective_to) && (
                <Text type="secondary">
                  {a.effective_from ?? '…'} → {a.effective_to ?? '…'}
                </Text>
              )}
            </Space>
          </List.Item>
        )}
      />
      <Form form={form} layout="inline" onFinish={(v) => void submit(v)}>
        <Form.Item name="weekday" rules={[{ required: true, message: t('common.required') }]}>
          <Select
            placeholder={t('professors.availability.weekday')}
            style={{ width: 130 }}
            options={weekdays.map((label, i) => ({ value: i, label }))}
          />
        </Form.Item>
        <Form.Item
          name="kind"
          initialValue="DISPO"
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Select
            style={{ width: 130 }}
            options={[
              { value: 'DISPO', label: t('professors.availability.dispo') },
              { value: 'INDISPO', label: t('professors.availability.indispo') },
            ]}
          />
        </Form.Item>
        <Form.Item name="start" rules={[{ required: true, message: t('common.required') }]}>
          <TimePicker format="HH:mm" minuteStep={15} placeholder={t('professors.availability.from')} />
        </Form.Item>
        <Form.Item name="end" rules={[{ required: true, message: t('common.required') }]}>
          <TimePicker format="HH:mm" minuteStep={15} placeholder={t('professors.availability.to')} />
        </Form.Item>
        <Form.Item name="range">
          <DatePicker.RangePicker placeholder={[t('professors.availability.from'), t('professors.availability.to')]} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
            {t('professors.availability.add')}
          </Button>
        </Form.Item>
      </Form>
    </Space>
  );
}

/** Couleurs de résolution (P9a) : À traiter orange, Partielle bleu, Résolue vert. */
const RESOLUTION_COLORS: Record<AbsenceResolution, string> = {
  A_TRAITER: 'orange',
  PARTIELLE: 'blue',
  RESOLUE: 'green',
};

/** minutes depuis minuit pour un dayjs (heure de début/fin). */
function minOf(d: Dayjs): number {
  return d.hour() * 60 + d.minute();
}

/**
 * Onglet Absences (P6b + P9a) : déclaration d'absence + liste enrichie
 * (résolution, nb impactées/décisions) + fiche d'une absence (séances
 * impactées PREVUE/REPORTEE avec leur décision) + modal de décision
 * (Remplacer / Reporter / Annuler). Le serveur reste autorité sur les
 * vérifications de disponibilité et les conflits BR-10 (modal détaillée).
 */
function AbsencesTab({
  professorId,
  onChanged,
}: {
  professorId: number;
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<{
    range: [dayjs.Dayjs, dayjs.Dayjs];
    reason?: string;
  }>();
  const [absences, setAbsences] = useState<AbsenceListRow[]>([]);
  const [impacted, setImpacted] = useState<ImpactedSession[] | null>(null);
  // Fiche de l'absence sélectionnée (séances impactées + décisions).
  const [detail, setDetail] = useState<AbsenceDetail | null>(null);
  // Remplaçants proposés : professeurs actifs ≠ titulaire.
  const [professors, setProfessors] = useState<ProfessorRow[]>([]);
  // Modal de décision.
  const [decideTarget, setDecideTarget] = useState<AbsenceDetailSession | null>(
    null,
  );
  const [decForm] = Form.useForm();
  const decKind = Form.useWatch('decision', decForm) as
    | AbsenceDecisionKind
    | undefined;
  const [deciding, setDeciding] = useState(false);
  const [refusal, setRefusal] = useState<PlacementConflict[] | null>(null);

  const loadAbsences = useCallback(async (): Promise<void> => {
    try {
      const res = await api().absences.list(professorId);
      if (res.ok) setAbsences(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  }, [professorId]);

  useEffect(() => {
    void loadAbsences();
    void api()
      .professors.list()
      .then((r) => {
        if (r.ok) setProfessors(r.data);
        else void message.error(errorMessage(r));
      })
      .catch((err) => void message.error(errorMessage(err)));
  }, [loadAbsences]);

  const loadDetail = async (id: number): Promise<void> => {
    try {
      const res = await api().absences.get(id);
      if (res.ok) setDetail(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  const submit = async (values: {
    range: [dayjs.Dayjs, dayjs.Dayjs];
    reason?: string;
  }): Promise<void> => {
    const input: AbsenceInput = {
      start_date: values.range[0].format('YYYY-MM-DD'),
      end_date: values.range[1].format('YYYY-MM-DD'),
      reason: values.reason?.trim() || null,
    };
    const res = await api().professors.absence.add(professorId, input);
    if (res.ok) {
      void message.success(t('professors.absence.added'));
      setImpacted(res.data.impacted);
      form.resetFields();
      await loadAbsences();
      onChanged();
    } else {
      if (res.fields) {
        const map: Record<string, string> = { start_date: 'range', end_date: 'range' };
        form.setFields(
          res.fields
            .filter((f) => map[f.field])
            .map((f) => ({ name: map[f.field], errors: [f.message] })) as never,
        );
      }
      void message.error(res.error);
    }
  };

  const remove = async (id: number): Promise<void> => {
    const res = await api().professors.absence.remove(id);
    if (res.ok) {
      void message.success(t('professors.absence.removed'));
      if (detail?.absence.id === id) setDetail(null);
      await loadAbsences();
      onChanged();
    } else {
      void message.error(errorMessage(res));
    }
  };

  const openDecide = (s: AbsenceDetailSession): void => {
    decForm.resetFields();
    decForm.setFieldsValue({ decision: 'REMPLACEMENT' });
    setDecideTarget(s);
  };

  const submitDecision = async (): Promise<void> => {
    if (!detail || !decideTarget) return;
    const v = (await decForm.validateFields()) as {
      decision: AbsenceDecisionKind;
      substitute_professor_id?: number;
      new_date?: dayjs.Dayjs;
      new_range?: [dayjs.Dayjs, dayjs.Dayjs];
      note?: string;
    };
    setDeciding(true);
    try {
      const res = await api().absences.decide(
        detail.absence.id,
        decideTarget.id,
        {
          decision: v.decision,
          substitute_professor_id: v.substitute_professor_id ?? null,
          new_date: v.new_date?.format('YYYY-MM-DD'),
          new_start: v.new_range ? minOf(v.new_range[0]) : undefined,
          new_end: v.new_range ? minOf(v.new_range[1]) : undefined,
          note: v.note?.trim() || null,
        },
      );
      if (res.ok) {
        void message.success(t('absences.saved'));
        setDecideTarget(null);
        // Rafraîchit séances impactées + résolution + compteurs du prof.
        await loadDetail(detail.absence.id);
        await loadAbsences();
        onChanged();
        return;
      }
      if (res.fields && res.fields.length > 0) {
        const map: Record<string, string> = {
          substitute_professor_id: 'substitute_professor_id',
          date: 'new_date',
          start_min: 'new_range',
          end_min: 'new_range',
          reason: 'note',
          note: 'note',
        };
        decForm.setFields(
          res.fields.map((f) => ({
            name: map[f.field] ?? f.field,
            errors: [f.message],
          })) as never,
        );
      }
      // Refus BR-10 : modal détaillée (jamais un simple toast).
      if (res.conflicts && res.conflicts.length > 0) {
        setRefusal(res.conflicts);
      } else {
        void message.error(res.error);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setDeciding(false);
    }
  };

  /** Colonnes des séances impactées + décision enregistrée + action. */
  const impactedCols: ColumnsType<AbsenceDetailSession> = [
    {
      key: 'date',
      title: t('professors.session.date'),
      render: (_v, s) => dayjs(s.date).format('ddd DD/MM/YYYY'),
    },
    {
      key: 'time',
      title: t('professors.session.time'),
      render: (_v, s) => `${minToHHMM(s.start_min)}–${minToHHMM(s.end_min)}`,
    },
    { key: 'module', title: t('professors.session.module'), dataIndex: 'module_name' },
    { key: 'master', title: t('professors.session.master'), dataIndex: 'master_name' },
    { key: 'room', title: t('professors.session.room'), dataIndex: 'room_name' },
    {
      key: 'status',
      title: t('professors.session.status'),
      render: (_v, s) => <StatusTag status={s.status} date={s.date} />,
    },
    {
      key: 'decision',
      title: t('absences.decisionCol'),
      render: (_v, s) =>
        s.decision ? (
          <Space direction="vertical" size={0}>
            <Space size={4} wrap>
              <Tag color="geekblue">
                {t(`absences.decisionKinds.${s.decision.decision}`)}
              </Tag>
              {s.decision.substitute_name && (
                <Text dir="auto">
                  {t('absences.substituteOf', {
                    name: s.decision.substitute_name,
                  })}
                </Text>
              )}
            </Space>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {s.decision.decided_at}
              {s.decision.decided_by_name &&
                ` ${t('absences.decidedBy', { name: s.decision.decided_by_name })}`}
            </Text>
          </Space>
        ) : (
          <Tag>{t('absences.pending')}</Tag>
        ),
    },
    {
      key: 'action',
      title: t('common.actions'),
      width: 90,
      render: (_v, s) =>
        s.decision == null ? (
          <Button size="small" onClick={() => openDecide(s)}>
            {t('absences.decide')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <List<AbsenceListRow>
        size="small"
        dataSource={absences}
        locale={{ emptyText: t('professors.absence.empty') }}
        renderItem={(a) => (
          <List.Item
            actions={[
              <Button
                key="see"
                size="small"
                onClick={() =>
                  detail?.absence.id === a.id
                    ? setDetail(null)
                    : void loadDetail(a.id)
                }
              >
                {t('absences.viewSessions')}
              </Button>,
              <Button
                key="del"
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                aria-label={t('common.delete')}
                onClick={() => void remove(a.id)}
              />,
            ]}
          >
            <Space direction="vertical" size={0}>
              <Space wrap>
                <Text>
                  {a.start_date} → {a.end_date}
                </Text>
                <Tag color={RESOLUTION_COLORS[a.resolution]}>
                  {t(`professors.absence.resolutions.${a.resolution}`)}
                </Tag>
                <Text type="secondary">
                  {t('absences.impactedCount', { count: a.nb_impacted })} ·{' '}
                  {t('absences.decisionsCount', { count: a.nb_decisions })}
                </Text>
              </Space>
              {a.reason && <Text type="secondary">{a.reason}</Text>}
            </Space>
          </List.Item>
        )}
      />
      <Form form={form} layout="inline" onFinish={(v) => void submit(v)}>
        <Form.Item name="range" rules={[{ required: true, message: t('common.required') }]}>
          <DatePicker.RangePicker />
        </Form.Item>
        <Form.Item name="reason">
          <Input placeholder={t('professors.absence.reason')} style={{ width: 220 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
            {t('professors.absence.add')}
          </Button>
        </Form.Item>
      </Form>
      {/* BR-17 : les séances impactées sont affichées, jamais annulées. */}
      {impacted !== null && (
        <Alert
          type={impacted.length > 0 ? 'warning' : 'info'}
          showIcon
          message={
            impacted.length > 0
              ? t('professors.absence.impacted', { count: impacted.length })
              : t('professors.absence.noImpacted')
          }
        />
      )}
      {impacted !== null && impacted.length > 0 && (
        <SessionsTable sessions={impacted} emptyText={t('common.empty')} />
      )}
      {/* Séances impactées de l'absence sélectionnée + leurs décisions. */}
      {detail != null && (
        <>
          <Text strong>{t('absences.detail')}</Text>
          <Table<AbsenceDetailSession>
            size="small"
            rowKey="id"
            columns={impactedCols}
            dataSource={detail.impacted}
            pagination={false}
            locale={{ emptyText: t('professors.absence.noImpacted') }}
          />
        </>
      )}
      {/* Modal de décision : Remplacer / Reporter / Annuler — le serveur
          reste autorité (disponibilités + conflits BR-10). */}
      <Modal
        title={t('absences.modalTitle', {
          date: decideTarget ? dayjs(decideTarget.date).format('DD/MM/YYYY') : '',
        })}
        open={decideTarget != null}
        onOk={() => void submitDecision()}
        onCancel={() => setDecideTarget(null)}
        confirmLoading={deciding}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form form={decForm} layout="vertical">
          <Form.Item
            name="decision"
            label={t('absences.decision')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Radio.Group
              options={ABSENCE_DECISIONS.map((d) => ({
                value: d,
                label: t(`absences.decisionKinds.${d}`),
              }))}
            />
          </Form.Item>
          {decKind === 'REMPLACEMENT' && (
            <Form.Item
              name="substitute_professor_id"
              label={t('absences.substitute')}
              rules={[{ required: true, message: t('common.required') }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={professors
                  .filter((p) => p.is_active === 1 && p.id !== professorId)
                  .map((p) => ({ value: p.id, label: p.full_name }))}
              />
            </Form.Item>
          )}
          {decKind === 'REPORT' && (
            <>
              <Form.Item
                name="new_date"
                label={t('absences.newSlot')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
              </Form.Item>
              <Form.Item
                name="new_range"
                label={t('professors.session.time')}
                rules={[{ required: true, message: t('common.required') }]}
              >
                <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
              </Form.Item>
            </>
          )}
          <Form.Item name="note" label={t('absences.note')}>
            <Input.TextArea
              rows={2}
              maxLength={200}
              placeholder={t('absences.notePlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>
      {/* Refus BR-10 de la décision — liste détaillée des conflits. */}
      <SessionConflictsModal
        conflicts={refusal}
        onClose={() => setRefusal(null)}
      />
    </Space>
  );
}

export function ProfessorsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ProfessorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ProfessorRow | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  const [detail, setDetail] = useState<ProfessorDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().professors.list();
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
      const res = await api().professors.get(id);
      if (res.ok) setDetail(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      // Rejet IPC : jamais de promesse non gérée sur un drawer ouvert.
      void message.error(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = (): void => {
    setEditing(null);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openEdit = (row: ProfessorRow): void => {
    setEditing(row);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openDetail = (row: ProfessorRow): void => {
    // Purge la fiche précédente : pas de données périmées ni de mutation
    // possible sur le mauvais professeur pendant le chargement.
    setDetail(null);
    setDetailOpen(true);
    void reloadDetail(row.id);
  };

  const submit = async (values: ProfessorInput): Promise<ApiResult<unknown>> => {
    const res = editing
      ? await api().professors.update(editing.id, values)
      : await api().professors.create(values);
    if (res.ok) {
      void message.success(t(editing ? 'professors.updated' : 'professors.created'));
      void reload();
    }
    return res;
  };

  const toggleActive = async (row: ProfessorRow): Promise<void> => {
    const res = await api().professors.setActive(row.id, row.is_active !== 1);
    if (res.ok) {
      void message.success(
        t(res.data.is_active === 1 ? 'professors.activated' : 'professors.deactivated'),
      );
      void reload();
    } else {
      void message.error(errorMessage(res));
    }
  };

  /** BR-22 : suppression refusée (données liées) → propose la désactivation. */
  const showDeleteRefused = (row: ProfessorRow, serverError?: string): void => {
    Modal.confirm({
      title: t('professors.deleteRefused'),
      content: serverError ?? t('professors.refusedBody', { count: row.linkedCount }),
      okText: t('common.deactivate'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const deact = await api().professors.setActive(row.id, false);
        if (deact.ok) {
          void message.success(t('professors.deactivated'));
          void reload();
        } else {
          void message.error(errorMessage(deact));
        }
      },
    });
  };

  const confirmDelete = (row: ProfessorRow): void => {
    if (row.linkedCount > 0) {
      showDeleteRefused(row);
      return;
    }
    Modal.confirm({
      title: t('professors.deleteTitle'),
      content: t('professors.deleteConfirmFree', { name: row.full_name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().professors.remove(row.id);
        if (res.ok) {
          void message.success(t('professors.deleted'));
          void reload();
        } else {
          showDeleteRefused(row, errorMessage(res));
        }
      },
    });
  };

  const columns: ColumnsType<ProfessorRow> = [
    {
      key: 'full_name',
      title: t('professors.name'),
      dataIndex: 'full_name',
      sorter: (a, b) => a.full_name.localeCompare(b.full_name, 'fr'),
      render: (v: string, row) => (
        <Space size="small">
          <span dir="auto">{v}</span>
          {row.is_demo === 1 && <Tag color="orange">DÉMO</Tag>}
        </Space>
      ),
    },
    {
      key: 'masters',
      title: t('professors.masters'),
      render: (_v, row) => (
        <Space size={4} wrap>
          {row.masters.slice(0, 2).map((m) => (
            <Tag key={m}>{m}</Tag>
          ))}
          {row.masters.length > 2 && <Tag>+{row.masters.length - 2}</Tag>}
        </Space>
      ),
    },
    {
      key: 'nb_realisees',
      title: t('professors.sessionsDone'),
      dataIndex: 'nb_realisees',
      sorter: (a, b) => a.nb_realisees - b.nb_realisees,
      width: 110,
    },
    {
      key: 'nb_restantes',
      title: t('professors.sessionsLeft'),
      dataIndex: 'nb_restantes',
      sorter: (a, b) => a.nb_restantes - b.nb_restantes,
      width: 110,
    },
    {
      key: 'nb_annulees',
      title: t('professors.sessionsCancelled'),
      dataIndex: 'nb_annulees',
      sorter: (a, b) => a.nb_annulees - b.nb_annulees,
      width: 100,
    },
    {
      key: 'heures_enseignees_min',
      title: t('professors.hoursTaught'),
      dataIndex: 'heures_enseignees_min',
      sorter: (a, b) => a.heures_enseignees_min - b.heures_enseignees_min,
      width: 130,
      render: (v: number) => fmtHM(v),
    },
    {
      key: 'status',
      title: t('professors.status'),
      filters: [
        { text: t('common.active'), value: 1 },
        { text: t('common.inactive'), value: 0 },
      ],
      onFilter: (value, row) => row.is_active === Number(value),
      width: 100,
      render: (_v, row) =>
        row.is_active === 1 ? (
          <Tag color="green">{t('common.active')}</Tag>
        ) : (
          <Tag>{t('common.inactive')}</Tag>
        ),
    },
  ];

  const p = detail?.professor;

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('professors.title')}
      </Title>
      <CrudTable<ProfessorRow>
        rows={rows}
        loading={loading}
        columns={columns}
        searchKeys={['full_name', 'internal_ref', 'email']}
        dimInactive
        onEdit={openEdit}
        onDelete={confirmDelete}
        onToggleActive={toggleActive}
        onRowClick={openDetail}
        toolbar={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('common.create')}
          </Button>
        }
      />
      <EntityDrawer<ProfessorInput>
        key={drawerKey}
        open={drawerOpen}
        title={t(editing ? 'professors.editTitle' : 'professors.createTitle')}
        initialValues={
          editing
            ? {
                full_name: editing.full_name,
                internal_ref: editing.internal_ref,
                email: editing.email,
                phone: editing.phone,
                is_active: editing.is_active === 1,
              }
            : { is_active: true }
        }
        onSubmit={submit}
        onClose={() => setDrawerOpen(false)}
        fieldNames={['full_name', 'internal_ref', 'email', 'phone', 'is_active']}
      >
        <Form.Item
          name="full_name"
          label={t('professors.name')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input autoFocus dir="auto" />
        </Form.Item>
        <Form.Item name="internal_ref" label={t('professors.internalRef')}>
          <Input />
        </Form.Item>
        <Form.Item name="email" label={t('professors.email')}>
          <Input type="email" />
        </Form.Item>
        <Form.Item name="phone" label={t('professors.phone')}>
          <Input />
        </Form.Item>
        <Form.Item name="is_active" label={t('professors.active')} valuePropName="checked">
          <Switch />
        </Form.Item>
      </EntityDrawer>
      <Drawer
        open={detailOpen}
        width={760}
        title={
          p ? (
            <span dir="auto">
              {t('professors.detailTitle', { name: p.full_name })}
            </span>
          ) : (
            t('common.loading')
          )
        }
        onClose={() => {
          setDetailOpen(false);
          void reload(); // compteurs/absences potentiellement modifiés
        }}
      >
        {detail && p && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label={t('professors.internalRef')}>
                {p.internal_ref ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('professors.email')}>
                {p.email ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('professors.phone')}>
                {p.phone ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('professors.teachings')}>
                {detail.teachings.length > 0 ? (
                  <span dir="auto">
                    {detail.teachings
                      .map((x) => `${x.master_name} — ${x.module_name}`)
                      .join(' · ')}
                  </span>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
            </Descriptions>
            {/* key=id : remonte les onglets par professeur — réinitialise
                l'onglet actif et l'état interne (impacted des absences). */}
            <Tabs
              key={p.id}
              items={[
                {
                  key: 'sessions',
                  label: t('professors.tabs.sessions'),
                  children: (
                    <SessionsTable
                      sessions={detail.upcoming}
                      emptyText={t('professors.session.empty')}
                    />
                  ),
                },
                {
                  key: 'availabilities',
                  label: t('professors.tabs.availabilities'),
                  children: (
                    <AvailabilitiesTab
                      professorId={p.id}
                      availabilities={detail.availabilities}
                      onChanged={() => void reloadDetail(p.id)}
                    />
                  ),
                },
                {
                  key: 'absences',
                  label: t('professors.tabs.absences'),
                  children: (
                    <AbsencesTab
                      professorId={p.id}
                      onChanged={() => void reloadDetail(p.id)}
                    />
                  ),
                },
                {
                  key: 'counters',
                  label: t('professors.tabs.counters'),
                  children: (
                    <Space wrap size="large">
                      <Statistic title={t('professors.counters.realisees')} value={p.nb_realisees} />
                      <Statistic title={t('professors.counters.restantes')} value={p.nb_restantes} />
                      <Statistic
                        title={t('professors.counters.nonRealisees')}
                        value={p.nb_non_realisees}
                      />
                      <Statistic title={t('professors.counters.annulees')} value={p.nb_annulees} />
                      <Statistic title={t('professors.counters.reportees')} value={p.nb_reportees} />
                      <Statistic
                        title={t('professors.counters.heures')}
                        value={fmtHM(p.heures_enseignees_min)}
                      />
                      <Statistic title={t('professors.counters.absences')} value={p.nb_absences} />
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        )}
      </Drawer>
    </Card>
  );
}
