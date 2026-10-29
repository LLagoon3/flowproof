import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Studio is served as static assets under a restrictive Content Security Policy,
// so the build must not emit inline scripts, inline styles, or inlined assets.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
})
