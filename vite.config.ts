import { fileURLToPath, URL } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Dev-only passthrough for RSS feeds, artwork and audio.
 *
 * The shipped app has no server component: on Android every outbound request
 * goes through Capacitor's native HTTP layer, which is not subject to CORS.
 * Browser dev has no such escape hatch, so this middleware stands in for it.
 * It exists only inside `vite dev` and is never part of a build.
 */
function devPassthrough(): Plugin {
  return {
    name: 'filterpod-dev-passthrough',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__passthrough', async (req, res) => {
        const target = new URL(req.url ?? '', 'http://x').searchParams.get('url')
        if (!target) {
          res.statusCode = 400
          res.end('missing url')
          return
        }
        try {
          const upstream = await fetch(target, {
            headers: {
              // Some CDNs 403 an unknown agent, and range requests keep audio seekable.
              'user-agent': 'FilterPod/0.1 (+https://filterpod.app)',
              ...(req.headers.range ? { range: String(req.headers.range) } : {}),
            },
            redirect: 'follow',
          })
          res.statusCode = upstream.status
          for (const header of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
            const value = upstream.headers.get(header)
            if (value) res.setHeader(header, value)
          }
          res.setHeader('access-control-allow-origin', '*')
          res.setHeader('cache-control', 'no-store')
          if (!upstream.body) {
            res.end()
            return
          }
          const reader = upstream.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
          res.end()
        } catch (error) {
          res.statusCode = 502
          res.end(String(error))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devPassthrough(),
    VitePWA({
      /**
       * Never ship the service worker inside the Capacitor app.
       *
       * In a packaged build every asset is already local, so the worker buys nothing —
       * and it actively hurts: it caches the app shell inside the WebView, so a freshly
       * installed APK keeps running the previous bundle. That silently masked several
       * rounds of fixes, which is a very expensive class of bug to debug.
       */
      disable: process.env.CAPACITOR_BUILD === '1',
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'FilterPod',
        short_name: 'FilterPod',
        description: 'A podcast player that automatically filters foul language.',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // A maskable icon is cropped to a circle by the launcher, so it is a separate
          // file with the mark kept inside the safe zone rather than filling the square.
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Episode audio and ASR model weights live in our own storage layer,
        // never in the Workbox precache.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  server: { port: 5173 },
  test: {
    // Vendored whisper.cpp ships its own JS test suite; it is not ours to run.
    include: ['src/**/*.test.ts'],
  },
})
