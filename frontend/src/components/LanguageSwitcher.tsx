import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface LangOption {
  code: string;
  nativeName: string;
  dir?: 'ltr' | 'rtl';
}

export const SUPPORTED_LANGUAGES: LangOption[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'fr', nativeName: 'Français' },
];

/**
 * LanguageSwitcher
 *
 * Dropdown that lets users change the UI language. Sits alongside the
 * NetworkSwitcher and ThemeToggle in the Navbar.
 *
 * To add a new locale:
 *   1. Add its JSON file to src/i18n/locales/<lang>.json
 *   2. Register it in src/i18n/index.ts
 *   3. Add an entry to SUPPORTED_LANGUAGES above
 */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const currentLang = SUPPORTED_LANGUAGES.find(
    (l) => l.code === i18n.resolvedLanguage
  ) ?? SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSelect(code: string) {
    void i18n.changeLanguage(code);
    setShowMenu(false);
  }

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        className="btn btn--ghost"
        onClick={() => setShowMenu((p) => !p)}
        aria-label={t('languageSwitcher.label')}
        aria-expanded={showMenu}
        aria-haspopup="listbox"
        style={{
          padding: '4px 10px',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        🌐
        <span>{currentLang.nativeName}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>▼</span>
      </button>

      {showMenu && (
        <ul
          role="listbox"
          aria-label={t('languageSwitcher.label')}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: '4px 0',
            minWidth: 140,
            zIndex: 50,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            listStyle: 'none',
            margin: 0,
          }}
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const isSelected = lang.code === i18n.resolvedLanguage;
            return (
              <li key={lang.code} role="option" aria-selected={isSelected}>
                <button
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 12,
                    textAlign: 'left',
                    background: isSelected ? '#334155' : 'transparent',
                    color: '#e2e8f0',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  onClick={() => handleSelect(lang.code)}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = '#2d3748';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                  }}
                  lang={lang.code}
                  dir={lang.dir ?? 'ltr'}
                >
                  {lang.nativeName}
                  {isSelected ? ' ✓' : ''}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
