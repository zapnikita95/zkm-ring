import { defineConfig } from 'vite'

/** PWA/SW в dev часто даёт «Failed to fetch» на /data — для прототипа сайта не нужен. */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        site: 'site/index.html',
        about: 'site/about.html',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  // geojson из public/ можно импортировать при необходимости
  assetsInclude: ['**/*.geojson'],
})
