import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DialogsProvider } from './Dialogs';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <DialogsProvider>
    <App />
  </DialogsProvider>,
);
