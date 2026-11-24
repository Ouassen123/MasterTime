/**
 * ParamsPage (P12 — FR-51, BR-24) — `/parametres`, réservée ADMIN.
 *
 * Trois onglets :
 * - **Créneaux horaires** : table `time_slot` (jour, début, fin, libellé,
 *   badge « chevauchement » — autorisé mais signalé) + Modal/Form
 *   (`TimePicker.RangePicker` en minutes) + suppression confirmée ;
 * - **Exceptions calendrier** : table `calendar_exception` (période,
 *   type taggé, libellé) + Modal/Form (`RangePicker` + Select type) ;
 * - **Sauvegarde** : `InputNumber` rétention 1–100 (`backup_retention`).
 *
 * Les erreurs serveur `fields[]` sont remappées sur les champs du Form
 * (pattern P7b — `setFields`). Un GESTIONNAIRE qui saisit l'URL voit un
 * avertissement (pas de garde de route — l'IPC refuse de toute façon).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  TimePicker,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { FormInstance } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  ApiResult,
  CalendarExceptionInput,
  CalendarExceptionRow,
  FieldError,
  TimeSlotInput,
  TimeSlotRow,
} from '../../shared/types';
import { CALENDAR_EXCEPTION_TYPES } from '../../shared/types';

const { Title, Text } = Typography;

/** Minutes → 'HH:MM' (conventions AD-7 : INTEGER minutes). */
function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(
    min % 60,
  ).padStart(2, '0')}`;
}

/** Minutes → Dayjs à heure fixe (valeur des TimePicker). */
function minToDayjs(min: number): Dayjs {
  return dayjs().startOf('day').add(min, 'minute');
}

/** Remappe les FieldError serveur sur les Form.Item (pattern P7b). */
function applyServerErrors(
  form: FormInstance,
  fields: FieldError[] | undefined,
  map: Record<string, string>,
): void {
  if (!fields) return;
  form.setFields(
    fields.map((f) => ({
      name: map[f.field] ?? f.field,
      errors: [f.message],
    })) as never,
  );
}

// --- Onglet Créneaux horaires -------------------------------------------------

interface SlotFormValues {
  weekday: number;
  range: [Dayjs, Dayjs];
  label?: string;
}

function SlotsTab(): React.JSX.Element {
  const { t } = useTranslation();
  const weekdays = t('weekdays', { returnObjects: true }) as unknown as string[];
  const [rows, setRows] = useState<TimeSlotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TimeSlotRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SlotFormValues>();

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().settings.slots.list();
      if (res.ok) setRows(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (row: TimeSlotRow): void => {
    setEditing(row);
    form.setFieldsValue({
      weekday: row.weekday,
      range: [minToDayjs(row.start_min), minToDayjs(row.end_min)],
      label: row.label ?? undefined,
    });
    setModalOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const input: TimeSlotInput = {
      weekday: values.weekday,
      start_min: values.range[0].hour() * 60 + values.range[0].minute(),
      end_min: values.range[1].hour() * 60 + values.range[1].minute(),
      label: values.label?.trim() || null,
    };
    setSubmitting(true);
    try {
      const res: ApiResult<TimeSlotRow> = editing
        ? await api().settings.slots.update(editing.id, input)
        : await api().settings.slots.create(input);
      if (res.ok) {
        void message.success(
          t(editing ? 'params.slots.updated' : 'params.slots.created'),
        );
        setModalOpen(false);
        void reload();
      } else {
        applyServerErrors(form, res.fields, {
          weekday: 'weekday',
          start_min: 'range',
          end_min: 'range',
          label: 'label',
        });
        void message.error(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<TimeSlotRow> = [
    {
      key: 'weekday',
      title: t('params.slots.weekday'),
      dataIndex: 'weekday',
      sorter: (a, b) => a.weekday - b.weekday || a.start_min - b.start_min,
      render: (v: number) => weekdays[v] ?? v,
    },
    {
      key: 'start',
      title: t('params.slots.from'),
      dataIndex: 'start_min',
      render: (v: number) => minToHHMM(v),
    },
    {
      key: 'end',
      title: t('params.slots.to'),
      dataIndex: 'end_min',
      render: (v: number) => minToHHMM(v),
    },
    {
      key: 'label',
      title: t('params.slots.label'),
      dataIndex: 'label',
      render: (v: string | null) => (v ? <span dir="auto">{v}</span> : '—'),
    },
    {
      key: 'overlaps',
      title: '',
      render: (_v, row) =>
        row.overlaps ? (
          <Tag color="orange">{t('params.slots.overlap')}</Tag>
        ) : null,
    },
    {
      key: '_actions',
      title: t('common.actions'),
      width: 110,
      render: (_v, row) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            aria-label={t('common.edit')}
            onClick={() => openEdit(row)}
          />
          <Popconfirm
            title={t('params.slots.deleteTitle')}
            description={t('params.slots.deleteConfirm')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              const res = await api().settings.slots.remove(row.id);
              if (res.ok) {
                void message.success(t('params.slots.deleted'));
                void reload();
              } else {
                void message.error(errorMessage(res));
              }
            }}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('common.delete')}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('params.slots.hint')}
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('params.slots.add')}
          </Button>
        </Space>
        <Table<TimeSlotRow>
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          locale={{ emptyText: t('params.slots.empty') }}
          pagination={{ pageSize: 15, showSizeChanger: false }}
        />
      </Space>
      <Modal
        open={modalOpen}
        title={t(
          editing ? 'params.slots.editTitle' : 'params.slots.createTitle',
        )}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={submitting}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Form<SlotFormValues> form={form} layout="vertical">
          <Form.Item
            name="weekday"
            label={t('params.slots.weekday')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              options={weekdays.map((label, i) => ({ value: i, label }))}
            />
          </Form.Item>
          <Form.Item
            name="range"
            label={t('params.slots.timeRange')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
          </Form.Item>
          <Form.Item name="label" label={t('params.slots.label')}>
            <Input maxLength={60} placeholder={t('params.slots.labelPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// --- Onglet Exceptions calendrier ----------------------------------------------

const TYPE_COLOR: Record<string, string> = {
  FERIE: 'gold',
  EXAMEN: 'volcano',
  FERMETURE: 'red',
  VACANCES: 'green',
};

interface ExceptionFormValues {
  range: [Dayjs, Dayjs];
  type: CalendarExceptionRow['type'];
  label: string;
}

function ExceptionsTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CalendarExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarExceptionRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ExceptionFormValues>();

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().settings.exceptions.list();
      if (res.ok) setRows(res.data);
      else void message.error(errorMessage(res));
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (row: CalendarExceptionRow): void => {
    setEditing(row);
    form.setFieldsValue({
      range: [dayjs(row.start_date), dayjs(row.end_date)],
      type: row.type,
      label: row.label,
    });
    setModalOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const input: CalendarExceptionInput = {
      start_date: values.range[0].format('YYYY-MM-DD'),
      end_date: values.range[1].format('YYYY-MM-DD'),
      type: values.type,
      label: values.label.trim(),
    };
    setSubmitting(true);
    try {
      const res: ApiResult<CalendarExceptionRow> = editing
        ? await api().settings.exceptions.update(editing.id, input)
        : await api().settings.exceptions.create(input);
      if (res.ok) {
        void message.success(
          t(
            editing
              ? 'params.exceptions.updated'
              : 'params.exceptions.created',
          ),
        );
        setModalOpen(false);
        void reload();
      } else {
        applyServerErrors(form, res.fields, {
          start_date: 'range',
          end_date: 'range',
          type: 'type',
          label: 'label',
        });
        void message.error(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<CalendarExceptionRow> = [
    {
      key: 'start',
      title: t('params.exceptions.start'),
      dataIndex: 'start_date',
      sorter: (a, b) => a.start_date.localeCompare(b.start_date),
    },
    {
      key: 'end',
      title: t('params.exceptions.end'),
      dataIndex: 'end_date',
    },
    {
      key: 'type',
      title: t('params.exceptions.type'),
      dataIndex: 'type',
      render: (v: CalendarExceptionRow['type']) => (
        <Tag color={TYPE_COLOR[v] ?? 'default'}>
          {t(`params.exceptions.types.${v}`)}
        </Tag>
      ),
    },
    {
      key: 'label',
      title: t('params.exceptions.label'),
      dataIndex: 'label',
      render: (v: string) => <span dir="auto">{v}</span>,
    },
    {
      key: '_actions',
      title: t('common.actions'),
      width: 110,
      render: (_v, row) => (
        <Space size="small">
          <Button
            size="small"
            icon={<EditOutlined />}
            aria-label={t('common.edit')}
            onClick={() => openEdit(row)}
          />
          <Popconfirm
            title={t('params.exceptions.deleteTitle')}
            description={t('params.exceptions.deleteConfirm')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              const res = await api().settings.exceptions.remove(row.id);
              if (res.ok) {
                void message.success(t('params.exceptions.deleted'));
                void reload();
              } else {
                void message.error(errorMessage(res));
              }
            }}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('common.delete')}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('params.exceptions.hint')}
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('params.exceptions.add')}
          </Button>
        </Space>
        <Table<CalendarExceptionRow>
          size="small"
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          locale={{ emptyText: t('params.exceptions.empty') }}
          pagination={{ pageSize: 15, showSizeChanger: false }}
        />
      </Space>
      <Modal
        open={modalOpen}
        title={t(
          editing
            ? 'params.exceptions.editTitle'
            : 'params.exceptions.createTitle',
        )}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={submitting}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Form<ExceptionFormValues> form={form} layout="vertical">
          <Form.Item
            name="range"
            label={t('params.exceptions.range')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <DatePicker.RangePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="type"
            label={t('params.exceptions.type')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Select
              options={CALENDAR_EXCEPTION_TYPES.map((v) => ({
                value: v,
                label: t(`params.exceptions.types.${v}`),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="label"
            label={t('params.exceptions.label')}
            rules={[{ required: true, message: t('common.required') }]}
          >
            <Input
              maxLength={120}
              placeholder={t('params.exceptions.labelPlaceholder')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// --- Onglet Sauvegarde (rétention) ----------------------------------------------

function RetentionTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hasApi()) return;
    void api()
      .settings.retention.get()
      .then((res) => {
        if (res.ok) setValue(res.data);
        else void message.error(errorMessage(res));
      })
      .catch((err) => void message.error(errorMessage(err)));
  }, []);

  const save = async (): Promise<void> => {
    if (value == null) return;
    setSaving(true);
    try {
      const res = await api().settings.retention.set(value);
      if (res.ok) {
        void message.success(t('params.retention.saved'));
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={t('params.retention.hint')}
      />
      <Space>
        <Text>{t('params.retention.label')}</Text>
        <InputNumber
          min={1}
          max={100}
          precision={0}
          value={value}
          onChange={(v) => setValue(v)}
        />
        <Button
          type="primary"
          loading={saving}
          disabled={value == null}
          onClick={() => void save()}
        >
          {t('common.save')}
        </Button>
      </Space>
    </>
  );
}

// --- Page ------------------------------------------------------------------------

export function ParamsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!hasApi()) {
      setIsAdmin(false);
      return;
    }
    void api()
      .profile.current()
      .then((res) => {
        setIsAdmin(res.ok ? res.data?.role === 'ADMIN' : false);
      })
      .catch(() => setIsAdmin(false));
  }, []);

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('params.title')}
      </Title>
      {isAdmin === false ? (
        <Alert type="warning" showIcon message={t('params.adminOnly')} />
      ) : (
        <Tabs
          items={[
            {
              key: 'slots',
              label: t('params.tabs.slots'),
              children: isAdmin ? <SlotsTab /> : null,
            },
            {
              key: 'exceptions',
              label: t('params.tabs.exceptions'),
              children: isAdmin ? <ExceptionsTab /> : null,
            },
            {
              key: 'backup',
              label: t('params.tabs.backup'),
              children: isAdmin ? <RetentionTab /> : null,
            },
          ]}
        />
      )}
    </Card>
  );
}
