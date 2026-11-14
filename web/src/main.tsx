import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { A11yProvider } from './a11y/A11yContext';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/Toast';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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
