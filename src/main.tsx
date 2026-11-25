import '@ant-design/v5-patch-for-react-19';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import frFR from 'antd/locale/fr_FR';
import dayjs from 'dayjs';
import 'dayjs/locale/fr';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './i18n';
import './styles.css';

dayjs.locale('fr');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={frFR}
      theme={{
        token: {
          colorPrimary: '#2563EB',
          colorInfo: '#2563EB',
          borderRadius: 8,
          controlHeight: 34,
          colorTextBase: '#0F172A',
          colorBgLayout: '#F1F5F9',
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        },
        components: {
          Layout: {
            siderBg: '#0F172A',
            headerBg: '#FFFFFF',
            headerHeight: 60,
            headerPadding: '0 24px',
          },
          Menu: {
            darkItemBg: 'transparent',
            darkSubMenuItemBg: 'transparent',
            darkItemColor: 'rgba(255,255,255,0.62)',
            darkItemHoverColor: '#FFFFFF',
            darkItemHoverBg: 'rgba(255,255,255,0.08)',
            darkItemSelectedBg: '#2563EB',
            darkItemSelectedColor: '#FFFFFF',
            itemBorderRadius: 8,
            itemHeight: 42,
            itemMarginBlock: 4,
          },
          Table: {
            headerBg: '#F8FAFC',
            headerColor: '#475569',
          },
        },
      }}
    >
      {/* HashRouter : compatible loadURL (dev) et loadFile (prod). */}
      <HashRouter>
        <App />
      </HashRouter>
    </ConfigProvider>
  </React.StrictMode>,
);
