/**
 * ModulesPage — référentiel Modules : Table + Drawer formulaire +
 * suppression protégée BR-22 (refus chiffré si master-modules liés).
 * Pas de `is_active` sur `module` : pas d'action désactiver.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Input,
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
import type { ApiResult, Module, ModuleInput } from '../../shared/types';

const { Title } = Typography;

export function ModulesPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Module | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().modules.list();
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

  const openEdit = (row: Module): void => {
    setEditing(row);
    setDrawerKey((k) => k + 1);
    setDrawerOpen(true);
  };

  const submit = async (values: ModuleInput): Promise<ApiResult<unknown>> => {
    const res = editing
      ? await api().modules.update(editing.id, values)
      : await api().modules.create(values);
    if (res.ok) {
      void message.success(t(editing ? 'modules.updated' : 'modules.created'));
      void reload();
    }
    return res;
  };

  const confirmDelete = (row: Module): void => {
    if (row.masterModuleCount > 0) {
      // BR-22 : la suppression serait refusée — refus chiffré direct,
      // sans tentative inutile (pas de is_active : pas d'alternative).
      Modal.error({
        title: t('modules.deleteRefused'),
        content: t('modules.refusedBody', { count: row.masterModuleCount }),
      });
      return;
    }
    Modal.confirm({
      title: t('modules.deleteTitle'),
      content: t('modules.deleteConfirmFree', { name: row.name }),
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const res = await api().modules.remove(row.id);
        if (res.ok) {
          void message.success(t('modules.deleted'));
          void reload();
        } else {
          Modal.error({
            title: t('modules.deleteRefused'),
            content: errorMessage(res),
          });
        }
      },
    });
  };

  const columns: ColumnsType<Module> = [
    {
      key: 'code',
      title: t('modules.code'),
      dataIndex: 'code',
      sorter: (a, b) => a.code.localeCompare(b.code, 'fr'),
    },
    {
      key: 'name',
      title: t('modules.name'),
      dataIndex: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name, 'fr'),
    },
    {
      key: 'masterModuleCount',
      title: t('modules.linked'),
      dataIndex: 'masterModuleCount',
      sorter: (a, b) => a.masterModuleCount - b.masterModuleCount,
    },
    {
      key: 'isDemo',
      title: t('modules.isDemo'),
      filters: [
        { text: t('modules.demoTag'), value: 1 },
        { text: t('modules.realTag'), value: 0 },
      ],
      onFilter: (value, row) => row.is_demo === Number(value),
      render: (_v, row) =>
        row.is_demo === 1 ? (
          <Tag color="orange">{t('modules.demoTag')}</Tag>
        ) : (
          <Tag color="blue">{t('modules.realTag')}</Tag>
        ),
    },
  ];

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('modules.title')}
      </Title>
      <CrudTable<Module>
        rows={rows}
        loading={loading}
        columns={columns}
        searchKeys={['code', 'name']}
        onEdit={openEdit}
        onDelete={confirmDelete}
        toolbar={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('common.create')}
          </Button>
        }
      />
      <EntityDrawer<ModuleInput>
        key={drawerKey}
        open={drawerOpen}
        title={t(editing ? 'modules.editTitle' : 'modules.createTitle')}
        initialValues={
          editing ? { code: editing.code, name: editing.name } : undefined
        }
        onSubmit={submit}
        onClose={() => setDrawerOpen(false)}
        fieldNames={['code', 'name']}
      >
        <Form.Item
          name="code"
          label={t('modules.code')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item
          name="name"
          label={t('modules.name')}
          rules={[{ required: true, message: t('common.required') }]}
        >
          <Input />
        </Form.Item>
      </EntityDrawer>
    </Card>
  );
}
