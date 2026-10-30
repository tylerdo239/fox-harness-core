// Code the first screen doesn't need, split out of the main bundle (docs/ui-performance-plan.md, phase 1). Each is
// fetched on first use, and also once the page is idle after start-up, so by the time someone opens a chart, a
// SQL block or the usage page it is already there and nothing flashes.
import { useEffect, useState } from 'react'

type SqlFormatter = typeof import('sql-formatter')

let sqlFormatter: SqlFormatter | undefined
let sqlFormatterLoad: Promise<SqlFormatter> | undefined

export function loadSqlFormatter(): Promise<SqlFormatter> {
  sqlFormatterLoad ??= import('sql-formatter').then((module) => (sqlFormatter = module))
  return sqlFormatterLoad
}

/** sql-formatter once loaded (undefined on the first render before it arrives; the caller shows the SQL as-is). */
export function useSqlFormatter(): SqlFormatter | undefined {
  const [module, setModule] = useState(sqlFormatter)
  useEffect(() => {
    if (module) return
    let alive = true
    void loadSqlFormatter().then((loaded) => alive && setModule(loaded))
    return () => {
      alive = false
    }
  }, [module])
  return module
}

/** Starts each loader when the browser is idle, one after another. Failures are ignored (first use retries). */
export function preloadWhenIdle(loaders: Array<() => Promise<unknown>>): void {
  const idle = (callback: () => void) =>
    'requestIdleCallback' in window ? window.requestIdleCallback(callback, { timeout: 3000 }) : setTimeout(callback, 1500)
  idle(() => {
    void loaders.reduce<Promise<unknown>>((previous, load) => previous.then(() => load().catch(() => undefined)), Promise.resolve())
  })
}
