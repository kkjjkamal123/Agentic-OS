import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Desktop } from './shell/Desktop';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Desktop />
  </StrictMode>,
);
