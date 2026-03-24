/**
 * main.js — SPA router for QuorumProof Frontend
 *
 * Routes:
 *   /         → home (redirects to /verify for now)
 *   /verify   → credential verification page
 */

import './styles.css';
import { renderVerifyPage } from './verify.js';

const app = document.getElementById('app');

function route() {
  const path = window.location.pathname;
  if (path === '/verify' || path === '/verify.html') {
    renderVerifyPage(app);
  } else {
    // Default: redirect to /verify
    window.history.replaceState({}, '', '/verify' + window.location.search);
    renderVerifyPage(app);
  }
}

// Initial route
route();

// Handle browser navigation (back/forward)
window.addEventListener('popstate', route);
