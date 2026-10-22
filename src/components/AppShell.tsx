/**
 * AppShell — Layout antd : sidebar fixe 240px (13 entrées dans l'ordre du
 * brief ; non implémenté = désactivé + tooltip « Phase ultérieure » ;
 * Paramètres/Sauvegardes réservés ADMIN — masqués en Gestionnaire, BR-24),
 * topbar 56px (profil actif + contexte année/semestre), bandeau DÉMO ambre
 * tant que des données `is_demo` existent (AD-11).
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Layout, Menu, Select, Space, Tooltip, Typography, message } from 'antd';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type { AppContext, AppUser, DbStatus } from '../../shared/types';

const { Sider, Header, Content } = Layout;
const { Text, Title } = Typography;

type NavKey =
  | 'dashboard' | 'masters' | 'professors' | 'modules' | 'rooms'
  | 'schedule' | 'generation' | 'sessions' | 'absences' | 'reports'
  | 'importExport' | 'settings' | 'backups';

interface NavEntry {
  key: NavKey;
  path: string;
  enabled: boolean;
  adminOnly?: boolean;
}

/** Ordre exact du brief (DESIGN note) — actives : Dashboard, Modules, Salles. */
const NAV: NavEntry[] = [
  { key: 'dashboard', path: '/', enabled: true },
  { key: 'masters', path: '/masters', enabled: false },
  { key: 'professors', path: '/professeurs', enabled: false },
  { key: 'modules', path: '/modules', enabled: true },
  { key: 'rooms', path: '/salles', enabled: true },
  { key: 'schedule', path: '/emplois-du-temps', enabled: false },
  { key: 'generation', path: '/generation', enabled: false },
  { key: 'sessions', path: '/seances', enabled: false },
  { key: 'absences', path: '/absences', enabled: false },
  { key: 'reports', path: '/rapports', enabled: false },
  { key: 'importExport', path: '/import-export', enabled: false },
  { key: 'settings', path: '/parametres', enabled: false, adminOnly: true },
  { key: 'backups', path: '/sauvegardes', enabled: false, adminOnly: true },
];

export function AppShell(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [profiles, setProfiles] = useState<AppUser[]>([]);
  const [currentProfile, setCurrentProfile] = useState<AppUser | null>(null);
  const [context, setContext] = useState<AppContext | null>(null);
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [apiMissing, setApiMissing] = useState(false);

  useEffect(() => {
    if (!hasApi()) {
      setApiMissing(true);
      return;
    }
    // Échec IPC / rejet : message visible, jamais d'erreur avalée en silence.
    const notifyError = (err: unknown): void => {
      void message.error(errorMessage(err));
    };
    void api()
      .profile.list()
      .then((res) => {
        if (res.ok) setProfiles(res.data);
        else notifyError(res);
      })
      .catch(notifyError);
    void api()
      .profile.current()
      .then((res) => {
        if (res.ok) setCurrentProfile(res.data);
        else notifyError(res);
      })
      .catch(notifyError);
    void api()
      .appContext()
      .then((res) => {
        if (res.ok) setContext(res.data);
        else notifyError(res);
      })
      .catch(notifyError);
    void api()
      .dbStatus()
      .then(setStatus)
      .catch(notifyError);
  }, []);

  const isAdmin = currentProfile?.role === 'ADMIN';

  const menuItems = useMemo<MenuProps['items']>(() => {
    return NAV.filter((e) => !e.adminOnly || isAdmin).map((e) => ({
      key: e.path,
      disabled: !e.enabled,
      label: e.enabled ? (
        t(`nav.${e.key}`)
      ) : (
        <Tooltip title={t('nav.later')} placement="right">
          <span>{t(`nav.${e.key}`)}</span>
        </Tooltip>
      ),
    }));
  }, [isAdmin, t]);

  const selectedKey =
    NAV.find((e) => e.path !== '/' && location.pathname.startsWith(e.path))
      ?.path ?? '/';

  const switchProfile = async (id: number): Promise<void> => {
    try {
      const res = await api().profile.set(id);
      if (res.ok) {
        setCurrentProfile(res.data);
        void message.success(
          t('profile.changed', { name: res.data.display_name }),
        );
      } else {
        void message.error(errorMessage(res));
      }
    } catch (err) {
      void message.error(errorMessage(err));
    }
  };

  const hasDemo = (status?.counts.demo ?? 0) > 0;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={240} theme="light">
        <div style={{ padding: '16px 16px 8px' }}>
          <Title level={4} style={{ margin: 0 }}>
            {t('app.title')}
          </Title>
        </div>
        <Menu
          mode="inline"
          items={menuItems}
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            height: 56,
            lineHeight: '56px',
            padding: '0 24px',
            borderBottom: '1px solid #E5E7EB',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text type="secondary">
            {context?.academicYear
              ? t('topbar.context', {
                  year: context.academicYear,
                  semester: context.semester ?? '—',
                })
              : t('topbar.contextEmpty')}
          </Text>
          <Space>
            <Text type="secondary">{t('topbar.profile')}</Text>
            <Select
              style={{ minWidth: 180 }}
              value={currentProfile?.id}
              options={profiles.map((p) => ({
                value: p.id,
                label: `${p.display_name} (${p.role})`,
              }))}
              onChange={(id) => void switchProfile(id)}
            />
          </Space>
        </Header>
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
        {hasDemo && (
          <Alert type="warning" showIcon message={t('demo.banner')} />
        )}
        <Content style={{ padding: 24, background: '#F4F5F7' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
