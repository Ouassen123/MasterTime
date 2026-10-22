/**
 * Routes — layout AppShell (sidebar 13 entrées + topbar). Actives en P6a :
 * Dashboard (placeholder), Salles, Modules ; le reste tombe sur
 * PlaceholderPage (entrées désactivées dans la sidebar).
 */
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { ModulesPage } from './pages/ModulesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { RoomsPage } from './pages/RoomsPage';

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="modules" element={<ModulesPage />} />
        <Route path="salles" element={<RoomsPage />} />
        <Route path="*" element={<PlaceholderPage />} />
      </Route>
    </Routes>
  );
}
