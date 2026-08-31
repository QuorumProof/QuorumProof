import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// i18n must be imported before any component that calls useTranslation()
import './i18n/index.ts'
import App from './App.tsx'
import { WalletProvider } from './context/WalletContext.tsx'
import { ToastProvider } from './context/ToastContext.tsx'
import { NetworkProvider } from './context/NetworkContext.tsx'
import { ThemeProvider } from './context/ThemeContext.tsx'
import { ToastContainer } from './components/ToastContainer.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { initSentry } from './lib/sentry.ts'

initSentry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <NetworkProvider>
          <WalletProvider>
            <ToastProvider>
              <App />
              <ToastContainer />
            </ToastProvider>
          </WalletProvider>
        </NetworkProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
