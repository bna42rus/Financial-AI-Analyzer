import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode}) => {
 if(mode==='staging'&&!process.env.VITE_API_ORIGIN)throw Error('CONNECTED_BUILD_API_REQUIRED');
 return { plugins: [react()], server: { host: '127.0.0.1', port: 5174, strictPort: true } };
});
