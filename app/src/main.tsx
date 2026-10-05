import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'

const container = document.getElementById('root')
if (!container) throw new Error('fox-harness-web: missing #root in index.html')

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
