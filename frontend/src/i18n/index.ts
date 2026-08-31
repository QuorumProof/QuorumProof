/**
 * i18n configuration — issue #1455
 *
 * Uses react-i18next / i18next.
 * Supported locales live in ./locales/<lang>.json.
 * The user's chosen language is persisted to localStorage under the key
 * "quorumproof-lang" so their preference survives page reloads.
 *
 * Adding a new locale:
 *   1. Create frontend/src/i18n/locales/<lang>.json (copy en.json as template)
 *   2. Import it below and add to the `resources` map
 *   3. Add the language to the SUPPORTED_LANGUAGES list in LanguageSwitcher.tsx
 *   4. Open a PR — see docs/I18N.md for the full contribution guide
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'

const STORAGE_KEY = 'quorumproof-lang'

/** Detect the best starting locale from storage → browser preference → fallback */
function detectLanguage(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) return stored

  // navigator.languages is ordered by user preference
  const browserLangs = navigator.languages ?? [navigator.language]
  for (const lang of browserLangs) {
    const base = lang.split('-')[0]
    if (['en', 'es', 'fr'].includes(base)) return base
  }
  return 'en'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
    },
    lng: detectLanguage(),
    fallbackLng: 'en',
    interpolation: {
      // React already escapes values — no double-escaping needed
      escapeValue: false,
    },
    saveMissing: false,
  })

// Persist language changes so the selection survives reloads
i18n.on('languageChanged', (lang) => {
  localStorage.setItem(STORAGE_KEY, lang)
  // Update the HTML lang attribute for screen readers / SEO
  document.documentElement.setAttribute('lang', lang)
})

export default i18n
