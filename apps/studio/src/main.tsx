import { createRoot } from 'react-dom/client'

const container = document.getElementById('root')

if (!container) {
  throw new Error('The Studio root element is missing.')
}

createRoot(container).render(<main>FlowProof Studio</main>)
