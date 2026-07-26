import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.filterpod',
  appName: 'FilterPod',
  webDir: 'dist',
  android: {
    // Episode audio is served to the WebView from app storage over this scheme.
    allowMixedContent: false,
    captureInput: false,
  },
  plugins: {
    CapacitorHttp: {
      // Routes fetch()/XHR through native, which sidesteps CORS for RSS and artwork.
      enabled: true,
    },
  },
}

export default config
