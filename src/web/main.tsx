import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/syne';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Agent Flight Recorder root element is missing.');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
