import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'data/*.json', 'data/*.geojson'],
      manifest: {
        name: 'Зелёный Маршрут',
        short_name: 'Зелёный Маршрут',
        description: 'Ваш кусок Зелёного кольца Москвы: пешком или на велосипеде',
        theme_color: '#121412',
        background_color: '#121412',
        display: 'standalone',
        orientation: 'portrait',
        lang: 'ru',
        start_url: '/',
        icons: [
          {
            src: 'icons/app-icon.png',
            sizes: '512x512',
            type: 'image/png',
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
