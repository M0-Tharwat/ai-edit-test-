import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// --- API Key Shim & Environment Polyfill ---
// This allows the app to work in deployments (like Vercel) where process.env might be missing,
// by allowing the user to provide the key via localStorage (managed by App.tsx UI).

if (typeof process === 'undefined') {
  (window as any).process = { env: {} };
}
if (!process.env) {
  (window as any).process.env = {};
}

// Restore key from storage if environment is empty
const storedKey = localStorage.getItem('GEMINI_API_KEY');
if (!process.env.API_KEY && storedKey) {
  process.env.API_KEY = storedKey;
}

// Shim for window.aistudio (as per GenAI SDK requirements for Pro models)
(window as any).aistudio = {
  hasSelectedApiKey: async () => !!process.env.API_KEY,
  openSelectKey: async () => {
    // Triggers the modal in App.tsx
    window.dispatchEvent(new CustomEvent('OPEN_API_KEY_MODAL'));
    return true; 
  }
};
// -------------------------------------------

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);