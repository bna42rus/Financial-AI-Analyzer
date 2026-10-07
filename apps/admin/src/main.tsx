import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './AdminApp';
import { ServerAdmin } from './ServerAdmin';
import { apiOrigin } from '../../web/src/server-client';
import '../../web/src/theme.css';
const root=document.getElementById('root');
if(!root)throw new Error('Application root is missing');
createRoot(root).render(<StrictMode>{apiOrigin?<ServerAdmin/>:<AdminApp/>}</StrictMode>);
