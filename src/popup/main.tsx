import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from './Popup.js';
import './popup.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('#root missing from popup.html');

createRoot(container).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);
