import { useEffect, useState } from 'react';
import { Alert, Card, Descriptions, Layout, Space, Statistic, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { AppInfo, DbStatus } from '../shared/types';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

const COUNT_KEYS = [
  'academicYear', 'semester', 'timeSlot', 'room',
  'master', 'professor', 'module', 'masterModule', 'session',
] as const;

export default function App(): React.JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [apiMissing, setApiMissing] = useState(false);

  useEffect(() => {
    if (!window.api) {
      setApiMissing(true);
      return;
    }
    void window.api.dbStatus().then(setStatus);
    void window.api.appInfo().then(setInfo);
  }, []);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header>
        <Title level={3} style={{ color: '#fff', margin: '14px 0 0' }}>
          {t('app.title')}
        </Title>
      </Header>
      <Content style={{ padding: 24 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Text type="secondary">{t('app.subtitle')}</Text>

          {apiMissing && (
            <Alert type="error" showIcon message={t('db.unavailable')} />
          )}

          {status && !status.ok && (
            <Alert
              type="error"
              showIcon
              message={t('db.error')}
              description={status.error}
            />
          )}

          {!status && !apiMissing && (
            <Alert type="info" message={t('db.loading')} />
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
      </Content>
    </Layout>
  );
}
