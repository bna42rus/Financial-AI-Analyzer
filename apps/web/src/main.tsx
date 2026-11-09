import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccessRequestPage } from './AccessRequestPage';
import { ServerAccess } from './ServerAccess';
import { apiOrigin } from './server-client';
import {isLegalPath,LegalPage} from './LegalPages';
import './theme.css';

const PublicDemo=lazy(()=>import('./PublicDemo').then(module=>({default:module.PublicDemo})));
const DemoApp=lazy(()=>import('./App').then(module=>({default:module.App})));
const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
function Root() {
  const [hash,setHash]=useState(window.location.hash);
  useEffect(()=>{const restore=()=>setHash(window.location.hash);window.addEventListener('hashchange',restore);window.addEventListener('popstate',restore);return()=>{window.removeEventListener('hashchange',restore);window.removeEventListener('popstate',restore);};},[]);
  const path=window.location.pathname;
  if(isLegalPath(path))return <LegalPage path={path}/>;
  const publicDemo=path==='/demo'||path==='/demo/';
  if(publicDemo)return <Suspense fallback={<p role="status">Открываем демо…</p>}><PublicDemo/></Suspense>;
  if(!apiOrigin&&hash!=='#access')return <Suspense fallback={<p role="status">Открываем пример…</p>}><DemoApp/></Suspense>;
  return apiOrigin?<ServerAccess/>:<AccessRequestPage/>;
}
createRoot(root).render(<StrictMode><Root /></StrictMode>);
