/**
 * AppShell — Layout antd : sidebar fixe 240px (13 entrées dans l'ordre du
 * brief ; non implémenté = désactivé + tooltip « Phase ultérieure » ;
 * Paramètres/Sauvegardes réservés ADMIN — masqués en Gestionnaire, BR-24),
 * topbar 56px (profil actif + contexte année/semestre), bandeau DÉMO ambre
 * tant que des données `is_demo` existent (AD-11).
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Layout, Menu, Select, Space, Tooltip, Typography, message } from 'antd';
import {
  BankOutlined,
  BarChartOutlined,
  BookOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  HomeOutlined,
  ScheduleOutlined,
  SettingOutlined,
  SwapOutlined,
  TableOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserDeleteOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, errorMessage, hasApi } from '../api/client';
import type { AppContext, AppUser, DbStatus } from '../../shared/types';

const { Sider, Header, Content } = Layout;
const { Text, Title } = Typography;

type NavKey =
  | 'dashboard' | 'masters' | 'professors' | 'modules' | 'rooms'
  | 'schedule' | 'edtArabe' | 'generation' | 'sessions' | 'absences' | 'reports'
  | 'importExport' | 'portal' | 'settings' | 'backups';

interface NavEntry {
  key: NavKey;
  path: string;
  enabled: boolean;
  adminOnly?: boolean;
  icon?: React.ReactNode;
}

/** Ordre exact du brief (DESIGN note) — actives : Dashboard, Masters,
 *  Modules, Professeurs, Salles. */
const NAV: NavEntry[] = [
  { key: 'dashboard', path: '/', enabled: true, icon: <DashboardOutlined /> },
  { key: 'masters', path: '/masters', enabled: true, icon: <BankOutlined /> },
  {
    key: 'professors',
    path: '/professeurs',
    enabled: true,
    icon: <TeamOutlined />,
  },
  { key: 'modules', path: '/modules', enabled: true, icon: <BookOutlined /> },
  { key: 'rooms', path: '/salles', enabled: true, icon: <HomeOutlined /> },
  {
    key: 'schedule',
    path: '/emplois-du-temps',
    enabled: true,
    icon: <CalendarOutlined />,
  },
  {
    key: 'edtArabe',
    path: '/edt-arabe',
    enabled: true,
    icon: <TableOutlined />,
  },
  {
    key: 'generation',
    path: '/generation',
    enabled: true,
    icon: <ThunderboltOutlined />,
  },
  { key: 'sessions', path: '/seances', enabled: true, icon: <ScheduleOutlined /> },
  {
    key: 'absences',
    path: '/absences',
    enabled: false,
    icon: <UserDeleteOutlined />,
  },
  {
    key: 'reports',
    path: '/rapports',
    enabled: true,
    icon: <BarChartOutlined />,
  },
  {
    key: 'importExport',
    path: '/import-export',
    enabled: true,
    icon: <SwapOutlined />,
  },
  {
    key: 'portal',
    path: '/portail',
    enabled: true,
    adminOnly: true,
    icon: <GlobalOutlined />,
  },
  {
    key: 'settings',
    path: '/parametres',
    enabled: true,
    adminOnly: true,
    icon: <SettingOutlined />,
  },
  {
    key: 'backups',
    path: '/sauvegardes',
    enabled: true,
    adminOnly: true,
    icon: <DatabaseOutlined />,
  },
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
      icon: e.icon,
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
      <Sider width={248} theme="dark" style={{ background: '#0F172A' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 20px 16px',
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: '0.02em',
              flexShrink: 0,
            }}
          >
            MT
          </div>
          <div style={{ minWidth: 0 }}>
            <Title level={5} style={{ margin: 0, color: '#fff', lineHeight: 1.2 }}>
              {t('app.title')}
            </Title>
            <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              FSJP Tanger
            </Text>
          </div>
        </div>
        <Menu
          mode="inline"
          theme="dark"
          items={menuItems}
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none', padding: '0 12px' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            height: 60,
            lineHeight: '60px',
            padding: '0 24px',
            boxShadow: '0 1px 2px rgba(15,23,42,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Space size={8}>
            <CalendarOutlined style={{ color: '#2563EB' }} />
            <Text strong style={{ fontSize: 15 }}>
              {context?.academicYear
                ? t('topbar.context', {
                    year: context.academicYear,
                    semester: context.semester ?? '—',
                  })
                : t('topbar.contextEmpty')}
            </Text>
          </Space>
          <Space size={8}>
            <Text type="secondary">{t('topbar.profile')}</Text>
            <Select
              style={{ minWidth: 200 }}
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
        <Content style={{ padding: 24, background: '#F1F5F9' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
