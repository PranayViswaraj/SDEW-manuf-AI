import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { A11yProvider } from './a11y/A11yContext';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import './index.css';
import { installBrowserServer } from './browser-server/install';

// GitHub Pages build: no separate server, the Python server runs in the browser.
if (import.meta.env.VITE_BROWSER_SERVER === '1') installBrowserServer();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter
      basename={import.meta.env.BASE_URL.replace(/\/+$/, '')}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <A11yProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </A11yProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
