import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'data/*.json', 'data/*.geojson'],
      manifest: {
        name: 'ЗКМ — кольцо Москвы',
        short_name: 'ЗКМ',
        description: 'Мини-игра: свой кусок Зелёного кольца Москвы пешком или на велосипеде',
        theme_color: '#0f1410',
        background_color: '#0f1410',
        display: 'standalone',
        orientation: 'portrait',
        lang: 'ru',
        start_url: '/',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,geojson,png,ico}'],
      },
    }),
  ],
})
