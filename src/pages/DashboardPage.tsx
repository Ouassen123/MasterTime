/**
 * Dashboard — placeholder P6a : état de la base + compteurs du jeu de
 * données. Les KPI métier (FR-1…5) arrivent avec les phases suivantes.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Card,
  Descriptions,
  Skeleton,
  Space,
  Statistic,
  Tag,
  message,
} from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { WarningOutlined } from '@ant-design/icons';
import { api, errorMessage, hasApi } from '../api/client';
import type {
  AppInfo,
  ConflictSummary,
  DbStatus,
} from '../../shared/types';

const COUNT_KEYS = [
  'academicYear', 'semester', 'timeSlot', 'room',
  'master', 'professor', 'module', 'masterModule', 'session', 'demo',
] as const;

export function DashboardPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [conflicts, setConflicts] = useState<ConflictSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hasApi()) {
      setLoading(false);
      return;
    }
    void Promise.allSettled([
      api().dbStatus(),
      api().appInfo(),
      api().timetable.summary(),
    ]).then(([statusRes, infoRes, conflictRes]) => {
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value);
      else void message.error(errorMessage(statusRes.reason));
      if (infoRes.status === 'fulfilled') setInfo(infoRes.value);
      else void message.error(errorMessage(infoRes.reason));
      if (
        conflictRes.status === 'fulfilled' &&
        conflictRes.value.ok
      ) {
        setConflicts(conflictRes.value.data);
      }
      setLoading(false);
    });
  }, []);

  if (loading) return <Skeleton active />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {status && !status.ok && (
        <Alert
          type="error"
          showIcon
          message={t('db.error')}
          description={status.error}
        />
      )}

      {status?.ok && (
        <Card title={t('db.statusTitle')}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color="green">{t('db.ok')}</Tag>
              <Statistic title={t('db.tableCount')} value={status.tableCount} />
            </Space>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('db.path')}>
                {status.dbPath}
              </Descriptions.Item>
              <Descriptions.Item label={t('db.migrations')}>
                {status.appliedMigrations.join(', ') || '—'}
              </Descriptions.Item>
            </Descriptions>
          </Space>
        </Card>
      )}

      {conflicts && (
        <Card
          title={
            <Space>
              <WarningOutlined
                style={{ color: conflicts.total > 0 ? '#DC2626' : '#16A34A' }}
              />
              {t('dashboard.conflicts')}
            </Space>
          }
          style={
            conflicts.total > 0 ? { borderLeft: '3px solid #DC2626' } : undefined
          }
          extra={<Link to="/emplois-du-temps">{t('dashboard.conflictsLink')}</Link>}
        >
          <Space wrap size="large">
            <Statistic
              title={t('dashboard.conflicts')}
              value={conflicts.total}
              valueStyle={
                conflicts.total > 0 ? { color: '#DC2626' } : undefined
              }
            />
            {(
              ['ROOM', 'PROFESSOR', 'MASTER', 'GROUP', 'EXTERNAL'] as const
            ).map((kind) =>
              conflicts.byKind[kind] > 0 ? (
                <Statistic
                  key={kind}
                  title={t(`dashboard.byKind.${kind}`)}
                  value={conflicts.byKind[kind]}
                />
              ) : null,
            )}
          </Space>
        </Card>
      )}

      {status?.ok && (
        <Card title={t('db.seedTitle')}>
          <Space wrap size="large">
            {COUNT_KEYS.map((key) => (
              <Statistic
                key={key}
                title={t(`counts.${key}`)}
                value={status.counts[key]}
              />
            ))}
          </Space>
        </Card>
      )}

      {info && (
        <Card title={t('info.title')} size="small">
          <Descriptions column={2} size="small">
            <Descriptions.Item label={t('info.appVersion')}>
              {info.appVersion}
            </Descriptions.Item>
            <Descriptions.Item label={t('info.electron')}>
              {info.electronVersion}
            </Descriptions.Item>
            <Descriptions.Item label={t('info.chrome')}>
              {info.chromeVersion}
            </Descriptions.Item>
            <Descriptions.Item label={t('info.node')}>
              {info.nodeVersion}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}
    </Space>
  );
}
