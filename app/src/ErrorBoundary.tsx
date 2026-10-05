// Real gap fixed 2026-09-10: this app had NO error boundary anywhere — any
// uncaught exception during render (anywhere in the tree) unmounts the
// whole thing, leaving `#root` empty. That's exactly what a user reported
// ("mở /chat/<id> ở tab khác — trắng hoàn toàn, không có gì cả") — and
// without a browser devtools session available in this session, a silent
// blank page is undiagnosable from either side: the user has nothing to
// report, and there's no error surfaced anywhere (not even a server log,
// since this never reaches the network). This doesn't fix whatever the
// underlying bug is — it makes the NEXT occurrence (of this or any other
// render-time crash) show a real, readable error instead of nothing, so it
// can actually be diagnosed.
//
// Must be a class component — `componentDidCatch`/`getDerivedStateFromError`
// have no hook equivalent (React does not support catching render errors
// from a function component). Deliberately has ZERO dependency on the rest
// of this app (no `useLocale`/`useTheme`/style.css classes) — if something
// upstream in the tree is broken enough to reach here, the fallback itself
// must not risk depending on whatever just failed. Plain inline styles only.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('fox-harness-web: uncaught render error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div style={{ maxWidth: 640, margin: '4em auto', padding: '0 1.5em', fontFamily: 'system-ui, sans-serif', color: '#1a1a1a' }}>
        <h1 style={{ fontSize: '1.3em' }}>Something went wrong</h1>
        <p>{error.message}</p>
        {error.stack && (
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75em', opacity: 0.7, overflowX: 'auto' }}>{error.stack}</pre>
        )}
        <button
          type="button"
          onClick={() => location.reload()}
          style={{ marginTop: '1em', height: 34, padding: '0 1em', borderRadius: 8, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
        >
          Reload
        </button>
      </div>
    )
  }
}
