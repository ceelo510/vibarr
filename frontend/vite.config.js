import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep React in a stable chunk so app changes do not churn vendor code.
        manualChunks(id) { if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.endsWith('/react') || id.endsWith('/react-dom')) return 'react'; if (id.includes('node_modules')) return 'vendor'; }
      }
    },
    cssCodeSplit: true,
    minify: 'esbuild'
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 5173
  }
});
