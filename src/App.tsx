/**
 * Routes — layout AppShell (sidebar 13 entrées + topbar). Actives :
 * Dashboard, Masters, Salles, Modules, Professeurs, Emplois du temps
 * (P7a), Génération (P8), Séances — registre (P9a), Rapports (P10),
 * Import/Export (P11), Paramètres & Sauvegardes (P12, adminOnly —
 * aucun garde de route : un GESTIONNAIRE saisissant l'URL voit un
 * avertissement et les IPC refusent, BR-24) ; le reste tombe sur
 * PlaceholderPage (entrées désactivées dans la sidebar).
 */
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { BackupsPage } from './pages/BackupsPage';
import { DashboardPage } from './pages/DashboardPage';
import { EdtArabePage } from './pages/EdtArabePage';
import { GenerationPage } from './pages/GenerationPage';
import { ImportExportPage } from './pages/ImportExportPage';
import { MastersPage } from './pages/MastersPage';
import { ModulesPage } from './pages/ModulesPage';
import { ParamsPage } from './pages/ParamsPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { PortalPage } from './pages/PortalPage';
import { ProfessorsPage } from './pages/ProfessorsPage';
import { ReportsPage } from './pages/ReportsPage';
import { RoomsPage } from './pages/RoomsPage';
import { SessionsPage } from './pages/SessionsPage';
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
        <Route path="edt-arabe" element={<EdtArabePage />} />
        <Route path="generation" element={<GenerationPage />} />
        <Route path="seances" element={<SessionsPage />} />
        <Route path="rapports" element={<ReportsPage />} />
        <Route path="import-export" element={<ImportExportPage />} />
        <Route path="parametres" element={<ParamsPage />} />
        <Route path="portail" element={<PortalPage />} />
        <Route path="sauvegardes" element={<BackupsPage />} />
        <Route path="*" element={<PlaceholderPage />} />
      </Route>
    </Routes>
  );
}
