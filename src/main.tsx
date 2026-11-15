import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import {CurrencyProvider} from './currency.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary label="app">
    <CurrencyProvider>
      <App />
    </CurrencyProvider>
  </ErrorBoundary>
);
