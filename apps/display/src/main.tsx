import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { syncCourts } from './scene/courts.js';
import './styles.css';

// Court dimensions come from the server where possible, so a sport module edit
// does not need a display rebuild.
void syncCourts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
