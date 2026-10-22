/**
 * i18next (AD-10) — namespace `fr` seul en v1 ; aucune chaîne littérale
 * dans les composants.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import fr from './fr.json';

void i18n.use(initReactI18next).init({
  lng: 'fr',
  fallbackLng: 'fr',
  resources: { fr: { translation: fr } },
  interpolation: { escapeValue: false },
});

export default i18n;
