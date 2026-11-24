/**
 * BackupsPage (P12 — FR-51/52/53, BR-23/24) — `/sauvegardes`, réservée
 * ADMIN.
 *
 * Table `backup_history` : date, type taggé (MANUEL / AUTO /
 * PRE_MIGRATION), taille formatée, chemin (`dir="auto"`), badges
 * « fichier absent » (ligne grisée, restauration impossible) et
 * « restaurée ».
 *
 * Actions : **Nouvelle sauvegarde** (VACUUM INTO côté main + rotation
 * `backup_retention`), **Restaurer** (Popconfirm d'avertissement —
 * redémarrage + sauvegarde de sécurité automatique, désactivée si le
 * fichier est absent), **Ouvrir le dossier**, **Supprimer** (Popconfirm
 * — PRE_MIGRATION refusée côté main : bouton désactivé + tooltip).
 *
 * Un GESTIONNAIRE qui saisit l'URL voit un avertissement (pas de garde
 * de route — l'IPC refuse de toute façon, BR-24).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type { BackupRow } from '../../shared/types';

const { Title, Text } = Typography;

/** 'YYYY-MM-DD HH:MM:SS' (UTC, `datetime('now')`) → heure locale FR. */
function formatAt(at: string): string {
  const d = new Date(at + 'Z');
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString('fr-FR');
}

/** Message le plus précis : FieldError métier s'il existe, sinon error. */
function showError(res: {
  error: string;
  fields?: { message: string }[];
}): void {
  void message.error(res.fields?.[0]?.message ?? res.error);
}

const KIND_COLOR: Record<BackupRow['kind'], string> = {
  MANUEL: 'blue',
  AUTO: 'cyan',
  PRE_MIGRATION: 'purple',
};

/** Taille lisible : '512 o', '12,4 Ko', '3,2 Mo' — null → '—'. */
function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} o`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace('.', ',')} Ko`;
  return `${(kb / 1024).toFixed(1).replace('.', ',')} Mo`;
}

export function BackupsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [rows, setRows] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

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

  const reload = useCallback(async (): Promise<void> => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api().backups.list();
      if (res.ok) setRows(res.data);
      else showError(res);
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void reload();
  }, [isAdmin, reload]);

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const res = await api().backups.create();
      if (res.ok) {
        void message.success(t('backups.created'));
        void reload();
      } else {
        showError(res);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    try {
      const res = await api().backups.openFolder();
      if (!res.ok) showError(res);
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  /** FR-52 : le processus redémarre au succès — la promesse IPC peut ne
   *  jamais se résoudre ; un `ok` reçu (dev/test) affiche le toast.
   *  `busyId` est libéré dans un finally : en dev/test l'app ne meurt
   *  pas et les boutons doivent se réactiver. */
  const restore = async (row: BackupRow): Promise<void> => {
    setBusyId(row.id);
    try {
      const res = await api().backups.restore(row.id);
      if (res.ok) {
        void message.success(t('backups.restored'));
      } else {
        showError(res);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: BackupRow): Promise<void> => {
    setBusyId(row.id);
    try {
      const res = await api().backups.remove(row.id);
      if (res.ok) {
        void message.success(t('backups.deleted'));
        void reload();
      } else {
        showError(res);
      }
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<BackupRow> = [
    {
      key: 'at',
      title: t('backups.cols.date'),
      dataIndex: 'at',
      sorter: (a, b) => a.at.localeCompare(b.at),
      defaultSortOrder: 'descend',
      render: (v: string) => formatAt(v),
    },
    {
      key: 'kind',
      title: t('backups.cols.kind'),
      dataIndex: 'kind',
      render: (v: BackupRow['kind']) => (
        <Tag color={KIND_COLOR[v]}>{t(`backups.kinds.${v}`)}</Tag>
      ),
    },
    {
      key: 'size',
      title: t('backups.cols.size'),
      dataIndex: 'size_bytes',
      align: 'right',
      sorter: (a, b) => (a.size_bytes ?? 0) - (b.size_bytes ?? 0),
      render: (v: number | null) => formatSize(v),
    },
    {
      key: 'path',
      title: t('backups.cols.path'),
      dataIndex: 'path',
      render: (v: string) => (
        <Text dir="auto" ellipsis={{ tooltip: v }} style={{ maxWidth: 320 }}>
          {v}
        </Text>
      ),
    },
    {
      key: 'status',
      title: t('backups.cols.status'),
      render: (_v, row) => (
        <Space size={4}>
          {!row.exists && <Tag color="red">{t('backups.missing')}</Tag>}
          {row.restored === 1 && (
            <Tag color="green">{t('backups.restoredTag')}</Tag>
          )}
        </Space>
      ),
    },
    {
      key: '_actions',
      title: t('common.actions'),
      width: 220,
      render: (_v, row) => (
        <Space size="small">
          <Popconfirm
            title={t('backups.restoreTitle')}
            description={t('backups.restoreConfirm')}
            okText={t('backups.restore')}
            cancelText={t('common.cancel')}
            onConfirm={() => void restore(row)}
            disabled={!row.exists}
          >
            <Tooltip title={!row.exists ? t('backups.missing') : undefined}>
              {/* <span> requis : un Tooltip ne fonctionne pas sur un
                  Button désactivé (plus d'événements souris). */}
              <span>
                <Button
                  size="small"
                  icon={<HistoryOutlined />}
                  disabled={!row.exists || busyId === row.id}
                >
                  {t('backups.restore')}
                </Button>
              </span>
            </Tooltip>
          </Popconfirm>
          {row.kind === 'PRE_MIGRATION' ? (
            <Tooltip title={t('backups.deleteRefused')}>
              <span>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled
                  aria-label={t('common.delete')}
                />
              </span>
            </Tooltip>
          ) : (
            <Popconfirm
              title={t('backups.deleteTitle')}
              description={t('backups.deleteConfirm')}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(row)}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={busyId === row.id}
                aria-label={t('common.delete')}
              />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Card>
      <Title level={4} style={{ marginTop: 0 }}>
        {t('backups.title')}
      </Title>
      {isAdmin === false ? (
        <Alert type="warning" showIcon message={t('backups.adminOnly')} />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }} wrap>
            <Button icon={<FolderOpenOutlined />} onClick={() => void openFolder()}>
              {t('backups.openFolder')}
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={creating}
              onClick={() => void create()}
            >
              {t('backups.create')}
            </Button>
          </Space>
          <Table<BackupRow>
            size="small"
            rowKey="id"
            loading={loading || isAdmin == null}
            columns={columns}
            dataSource={rows}
            rowClassName={(row) => (row.exists ? '' : 'row-inactive')}
            locale={{ emptyText: t('backups.empty') }}
            pagination={{ pageSize: 15, showSizeChanger: false }}
          />
        </Space>
      )}
    </Card>
  );
}
