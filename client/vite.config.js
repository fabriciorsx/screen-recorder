import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['disarray-turf-unaudited.ngrok-free.dev'],
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3000', // Aponta para o seu backend local
        ws: true // Permite tráfego de WebSocket
      }
    }
  }
})
