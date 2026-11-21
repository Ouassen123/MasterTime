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
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import { CrudTable } from '../components/CrudTable';
import { EntityDrawer } from '../components/EntityDrawer';
import {
  effectiveSessionStatus,
  type AbsenceInput,
  type AbsenceRow,
  type ApiResult,
  type AvailabilityInput,
  type AvailabilityRow,
  type EffectiveSessionStatus,
  type ImpactedSession,
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

function AbsencesTab({
  professorId,
  absences,
  onChanged,
}: {
  professorId: number;
  absences: AbsenceRow[];
  onChanged: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<{
    range: [dayjs.Dayjs, dayjs.Dayjs];
    reason?: string;
  }>();
  const [impacted, setImpacted] = useState<ImpactedSession[] | null>(null);

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
      onChanged();
    } else {
      void message.error(errorMessage(res));
    }
  };

  const resolutionColor = (r: AbsenceRow['resolution']): string =>
    r === 'RESOLUE' ? 'green' : r === 'PARTIELLE' ? 'gold' : 'red';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <List<AbsenceRow>
        size="small"
        dataSource={absences}
        locale={{ emptyText: t('professors.absence.empty') }}
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
            <Space direction="vertical" size={0}>
              <Space>
                <Text>
                  {a.start_date} → {a.end_date}
                </Text>
                <Tag color={resolutionColor(a.resolution)}>
                  {t(`professors.absence.resolutions.${a.resolution}`)}
                </Tag>
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
                      absences={detail.absences}
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
