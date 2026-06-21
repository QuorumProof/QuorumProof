import './buffer-polyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { WalletProvider } from './context/WalletContext.tsx';
import { NotificationProvider } from './context/NotificationContext.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { ToastContainer } from './components/ToastContainer.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletProvider>
        <NotificationProvider>
          <ToastProvider>
            <App />
            <ToastContainer />
          </ToastProvider>
        </NotificationProvider>
      </WalletProvider>
    </ErrorBoundary>
  </StrictMode>,
);
