import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    allowedHosts: ['inseparable-figureless-karrie.ngrok-free.dev'],
    cors: true, // This allows GHL to talk to your app
    headers: {
      "ngrok-skip-browser-warning": "true",
      "Content-Security-Policy": "frame-ancestors self https://*.gohighlevel.com https://*.msgsndr.com;"
    }
  }
})