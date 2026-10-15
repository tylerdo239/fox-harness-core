// State of the canvas side panel (ported from local-fox-harness-core's apps/web lib/store.ts, canvas part only).
// A store outside React on purpose: canvas.ts drives it from the conversation's event handling and from button
// handlers, neither of which is a component render. Reset whenever the conversation switches session.

import { create } from 'zustand'

import type { CanvasMarker } from './canvas.ts'

export interface CanvasVersion {
  readonly version: number
  readonly path: string
  // Text canvases only; a file canvas's bytes are fetched by `path` when shown.
  readonly content: string
  readonly source: 'model' | 'user'
  // Canvases opened from a workspace file: the file's mtime when snapshotted, so reopening it after the agent
  // rewrote it adds a new version instead of showing a stale one.
  readonly modified?: number
}

export interface CanvasItem {
  readonly id: string
  // 'file' = an .xlsx/.csv/.docx/.pdf/image snapshot.
  readonly kind: 'code' | 'markdown' | 'file'
  readonly title: string
  readonly language?: string
  // Ascending by version.
  readonly versions: readonly CanvasVersion[]
  readonly activeVersion: number
}

// How the panel reaches the gateway: set by the conversation (it holds the runtime), so canvas.ts needs no React.
export type CanvasFetch = (path: string, init?: RequestInit) => Promise<Response>

interface CanvasState {
  sessionId: string | undefined
  open: boolean
  activeId: string | undefined
  items: Record<string, CanvasItem>
  // Every canvas_write marker seen in this session, in event order: reopening a closed canvas replays them.
  markers: { marker: CanvasMarker; seq: number }[]
  // Highest event seq seen, for "closed the panel" memory (canvas.ts dismissPanel).
  lastSeq: number
  fetch: CanvasFetch | undefined
  reset: (sessionId: string | undefined) => void
  setFetch: (fetch: CanvasFetch) => void
  setOpen: (open: boolean) => void
  setActiveId: (id: string | undefined) => void
  upsertItem: (id: string, patch: { kind: CanvasItem['kind']; title: string; language?: string }) => void
  upsertVersion: (id: string, version: CanvasVersion) => void
  setActiveVersion: (id: string, version: number) => void
  // The switcher's "X": the most recently added remaining canvas takes its place; with none left the panel closes.
  removeItem: (id: string) => void
}

export const useCanvasStore = create<CanvasState>((set) => ({
  sessionId: undefined,
  open: false,
  activeId: undefined,
  items: {},
  markers: [],
  lastSeq: 0,
  fetch: undefined,
  reset: (sessionId) => { set({ sessionId, open: false, activeId: undefined, items: {}, markers: [], lastSeq: 0 }) },
  setFetch: (fetch) => { set({ fetch }) },
  setOpen: (open) => { set({ open }) },
  setActiveId: (activeId) => { set({ activeId }) },
  upsertItem: (id, patch) => {
    set((state) => {
      const existing = state.items[id]
      const item: CanvasItem = existing === undefined
        ? { id, ...patch, versions: [], activeVersion: 0 }
        // A later write may change the title or language; an omitted language clears it (code → markdown).
        : { ...existing, kind: patch.kind, title: patch.title, language: patch.language }
      return { items: { ...state.items, [id]: item } }
    })
  },
  upsertVersion: (id, version) => {
    set((state) => {
      const item = state.items[id]
      if (item === undefined) return state
      const versions = [...item.versions.filter((v) => v.version !== version.version), version].sort((a, b) => a.version - b.version)
      return { items: { ...state.items, [id]: { ...item, versions } } }
    })
  },
  setActiveVersion: (id, version) => {
    set((state) => {
      const item = state.items[id]
      if (item === undefined) return state
      return { items: { ...state.items, [id]: { ...item, activeVersion: version } } }
    })
  },
  removeItem: (id) => {
    set((state) => {
      if (state.items[id] === undefined) return state
      const { [id]: _removed, ...rest } = state.items
      const remaining = Object.keys(rest)
      const activeId = state.activeId === id ? remaining.at(-1) : state.activeId
      return { items: rest, activeId, open: activeId !== undefined && state.open }
    })
  },
}))
