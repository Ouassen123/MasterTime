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
          colorPrimary: '#1D4ED8',
          borderRadius: 6,
          fontFamily: 'Segoe UI, system-ui, sans-serif',
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
