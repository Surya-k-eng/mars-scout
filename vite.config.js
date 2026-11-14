import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/mcd': {
        target: 'https://www-mars.lmd.jussieu.fr',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/mcd/, ''),
      },
    },
    watch: {
      ignored: ['**/public/tiles/**'],
    },
  },
});
