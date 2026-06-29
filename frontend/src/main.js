/**
 * main.js — SPA router for QuorumProof Frontend
 *
 * Routes:
 *   /         → home (redirects to /verify for now)
 *   /verify   → credential verification page
 */

import './styles.css';
import { renderVerifyPage } from './verify.js';
import { renderDashboardPage } from './dashboard.js';

// ── Theme initialisation (run before first render to avoid flash) ─────────
function initTheme() {
  const stored = localStorage.getItem('qp-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = stored ?? (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;

  // Keep in sync when the OS preference changes (only if no manual override)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('qp-theme')) {
      document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
    }
  });
}

initTheme();

const app = document.getElementById('app');

function route() {
  const path = window.location.pathname;
  if (path === '/verify' || path === '/verify.html') {
    renderVerifyPage(app);
  } else if (path === '/dashboard' || path === '/dashboard.html') {
    renderDashboardPage(app);
  } else {
    // Default: redirect to /dashboard
    window.history.replaceState({}, '', '/dashboard' + window.location.search);
    renderDashboardPage(app);
  }
}

// Initial route
route();

// Handle browser navigation (back/forward)
window.addEventListener('popstate', route);

// Export router utility to easily switch pages from the navbar
export function navigateTo(path) {
  window.history.pushState({}, '', path);
  route();
}
