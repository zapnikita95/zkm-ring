import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'ru.zeleny.marshrut',
  appName: 'Зелёный Маршрут',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    Geolocation: {
      // permissions requested at runtime
    },
  },
}

export default config
