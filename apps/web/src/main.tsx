import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AccessRequestPage } from './AccessRequestPage';
import { ServerAccess } from './ServerAccess';
import { apiOrigin } from './server-client';
import './theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
function Root() {
  const [hash,setHash]=useState(window.location.hash);
  useEffect(()=>{const restore=()=>setHash(window.location.hash);window.addEventListener('hashchange',restore);window.addEventListener('popstate',restore);return()=>{window.removeEventListener('hashchange',restore);window.removeEventListener('popstate',restore);};},[]);
  return apiOrigin?<ServerAccess/>:hash==='#access'?<AccessRequestPage/>:<App/>;
}
createRoot(root).render(<StrictMode><Root /></StrictMode>);
