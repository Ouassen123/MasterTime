/**
 * RoomsPage — référentiel Salles : Table (recherche/tri/pagination) + Drawer
 * formulaire + suppression protégée BR-22 (refus chiffré → propose la
 * désactivation `is_active=0`).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Tag,
  Typography,
  message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import { CrudTable } from '../components/CrudTable';
import { EntityDrawer } from '../components/EntityDrawer';
import type { ApiResult, Room, RoomInput } from '../../shared/types';

const { Title } = Typography;

export function RoomsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().rooms.list();
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
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const openEdit = (row: Room): void => {
    setEditing(row);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const submit = async (values: RoomInput): Promise<ApiResult<unknown>> => {
    const res = editing
      ? await api().rooms.update(editing.id, values)
      : await api().rooms.create(values);
    if (res.ok) {
      void message.success(t(editing ? 'rooms.updated' : 'rooms.created'));
      void reload();
    }
    return res;
  };

  const toggleActive = async (row: Room): Promise<void> => {
    const res = await api().rooms.setActive(row.id, row.is_active !== 1);
    if (res.ok) {
      void message.success(
        t(res.data.is_active === 1 ? 'rooms.activated' : 'rooms.deactivated'),
      );
      void reload();
    } else {
      void message.error(errorMessage(res));
    }
  };

  /** BR-22 : suppression refusée (séances liées) → propose la désactivation. */
  const showDeleteRefused = (row: Room, serverError?: string): void => {
    Modal.confirm({
      title: t('rooms.deleteRefused'),
      content:
        serverError ?? t('rooms.refusedBody', { count: row.sessionCount }),
      okText: t('common.deactivate'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const deact = await api().rooms.setActive(row.id, false);
        if (deact.ok) {
          void message.success(t('rooms.deactivated'));
          void reload();
        } else {
          void message.error(errorMessage(deact));
        }
      },
    });
  };

  const confirmDelete = (row: Room): void => {
    if (row.sessionCount > 0) {
      // La suppression serait refusée (BR-22) — court-circuit vers le refus
      // chiffré + proposition de désactivation, sans tentative inutile.
      showDeleteRefused(row);
      return;
    }
    Modal.confirm({
      title: t('rooms.deleteTitle'),
      content: t('rooms.deleteConfirmFree', { name: row.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().rooms.remove(row.id);
        if (res.ok) {
          void message.success(t('rooms.deleted'));
          void reload();
        } else {
          // Refus serveur (ex. séances liées apparues entre-temps).
          showDeleteRefused(row, errorMessage(res));
        }
      },
    });
  };

  const columns: ColumnsType<Room> = [
    {
      key: 'name',
      title: t('rooms.name'),
      dataIndex: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name, 'fr'),
    },
    {
      key: 'capacity',
      title: t('rooms.capacity'),
      dataIndex: 'capacity',
      sorter: (a, b) => (a.capacity ?? 0) - (b.capacity ?? 0),
      render: (v: number | null) => v ?? '—',
    },
    {
      key: 'sessionCount',
      title: t('rooms.linkedSessions'),
      dataIndex: 'sessionCount',
      sorter: (a, b) => a.sessionCount - b.sessionCount,
    },
    {
      key: 'status',
      title: t('rooms.status'),
      filters: [
        { text: t('common.active'), value: 1 },
        { text: t('common.inactive'), value: 0 },
      ],
      onFilter: (value, row) => row.is_active === Number(value),
      render: (_v, row) =>
        row.is_active === 1 ? (
          <Tag color="green">{t('common.active')}</Tag>
        ) : (
          <Tag>{t('common.inactive')}</Tag>
        ),
    },
  ];

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('rooms.title')}
      </Title>
      <CrudTable<Room>
        rows={rows}
        loading={loading}
        columns={columns}
        searchKeys={['name']}
        dimInactive
        onEdit={openEdit}
        onDelete={confirmDelete}
        onToggleActive={toggleActive}
        toolbar={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('common.create')}
          </Button>
        }
      />
      <EntityDrawer<RoomInput>
        key={drawerKey}
        open={drawerOpen}
        title={t(editing ? 'rooms.editTitle' : 'rooms.createTitle')}
        initialValues={
          editing ? { name: editing.name, capacity: editing.capacity } : undefined
        }
        onSubmit={submit}
        onClose={() => setDrawerOpen(false)}
        fieldNames={['name', 'capacity']}
      >
        <Form.Item
          name="name"
          label={t('rooms.name')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item name="capacity" label={t('rooms.capacity')}>
          <InputNumber
            min={1}
            precision={0}
            style={{ width: '100%' }}
            placeholder={t('rooms.capacityPlaceholder')}
          />
        </Form.Item>
      </EntityDrawer>
    </Card>
  );
}
