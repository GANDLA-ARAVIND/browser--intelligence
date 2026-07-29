import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './index.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('#root missing from dashboard.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
