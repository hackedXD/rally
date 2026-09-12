import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { syncCourts } from './scene/courts.js';
import { syncTheme } from './theme.js';
import './styles.css';

// The renderer's copy of the palette, reconciled against the stylesheet that
// owns it. Runs before the first frame so no court is ever painted stale.
syncTheme();

// Court dimensions come from the server where possible, so a sport module edit
// does not need a display rebuild.
void syncCourts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
