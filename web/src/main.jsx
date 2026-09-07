import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles.css';

// Outside StrictMode, not inside it. StrictMode double-invokes render in
// development and re-throws what a boundary caught so it reaches the console;
// with the boundary inside, that machinery sits under the thing it is meant to
// protect. Outermost is also simply where a last resort belongs.
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <StrictMode>
      <App />
    </StrictMode>
  </ErrorBoundary>
);
