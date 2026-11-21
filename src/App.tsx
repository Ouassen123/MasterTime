/**
 * Routes — layout AppShell (sidebar 13 entrées + topbar). Actives :
 * Dashboard, Salles, Modules, Professeurs ; le reste tombe sur
 * PlaceholderPage (entrées désactivées dans la sidebar).
 */
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { ModulesPage } from './pages/ModulesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ProfessorsPage } from './pages/ProfessorsPage';
import { RoomsPage } from './pages/RoomsPage';

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="modules" element={<ModulesPage />} />
        <Route path="professeurs" element={<ProfessorsPage />} />
        <Route path="salles" element={<RoomsPage />} />
        <Route path="*" element={<PlaceholderPage />} />
      </Route>
    </Routes>
  );
}
