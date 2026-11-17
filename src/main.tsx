import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import {CurrencyProvider} from './currency.tsx';
import {AuthProvider} from './context/AuthContext.tsx';
import {AuthPromptProvider} from './context/AuthPromptContext.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="app">
    <CurrencyProvider>
      <AuthProvider>
        <AuthPromptProvider>
          <App />
        </AuthPromptProvider>
      </AuthProvider>
    </CurrencyProvider>
  </ErrorBoundary>
);
