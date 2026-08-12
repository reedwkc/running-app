import { defineConfig } from 'vite';

export default defineConfig({
  base: '/running-app/',
  test: {
    setupFiles: ['./src/test-setup.js'],
  },
});
