import { defineConfig } from 'vite'

// The trusted demo fixture is built once per phase and served as static files from a
// FlowProof-owned document root, so the build stays relative and fully external.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
})
