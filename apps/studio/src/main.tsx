/// <reference types="vite/client" />
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
// The one stylesheet; the build emits it as a standalone asset, so the CSP needs no inline styles.
import './styles.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('The Studio root element is missing.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
