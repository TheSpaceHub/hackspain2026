import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const HTTPS = process.env.SOFTPHONE_HTTPS === '1';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(HTTPS ? [basicSsl()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '::',
    port: 5175,
  },
});
