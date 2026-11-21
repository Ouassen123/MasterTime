/**
 * Routes — layout AppShell (sidebar 13 entrées + topbar). Actives :
 * Dashboard, Masters, Salles, Modules, Professeurs, Emplois du temps
 * (P7a) ; le reste tombe sur PlaceholderPage (entrées désactivées dans
 * la sidebar).
 */
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { MastersPage } from './pages/MastersPage';
import { ModulesPage } from './pages/ModulesPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ProfessorsPage } from './pages/ProfessorsPage';
import { RoomsPage } from './pages/RoomsPage';
import { TimetablePage } from './pages/TimetablePage';

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="masters" element={<MastersPage />} />
        <Route path="modules" element={<ModulesPage />} />
        <Route path="professeurs" element={<ProfessorsPage />} />
        <Route path="salles" element={<RoomsPage />} />
        <Route path="emplois-du-temps" element={<TimetablePage />} />
        <Route path="*" element={<PlaceholderPage />} />
      </Route>
    </Routes>
  );
}
