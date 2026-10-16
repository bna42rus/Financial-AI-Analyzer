import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({mode}) => {
  if(mode==='staging'&&!process.env.VITE_API_ORIGIN)throw Error('CONNECTED_BUILD_API_REQUIRED');
  return {
  plugins: [react()],
  // The device-only PDF entry is lazy; prebundle it to avoid a first-use dev-server reload.
  optimizeDeps: { include: ['pdfjs-dist', 'tesseract.js'] },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
};
});
