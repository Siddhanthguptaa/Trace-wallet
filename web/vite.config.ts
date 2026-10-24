import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@\//, replacement: '/src/' }] },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], viem: ['viem'], react: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
