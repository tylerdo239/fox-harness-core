// The chat's workspace files, shared between WorkspaceFiles.tsx (which lists and refreshes them) and the per-turn
// file boxes in the chat log (TurnFiles.tsx), so a long chat makes one listing request, not one per turn.

import { create } from 'zustand'
import { File as FileGeneric, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2 } from 'lucide-react'

import type { WorkspaceFile } from '../conversation/workspaceApi.ts'

// A canvas version (`canvas-<id>-vN.ext`): the canvas chip stands for it, not a file card.
export const CANVAS_VERSION_RE = /(^|\/)canvas-([a-z0-9-]+)-v(\d+)(\.[a-z0-9]+)$/

interface SessionFilesState {
  sessionId: string | undefined
  files: WorkspaceFile[] | undefined
  publish: (sessionId: string | undefined, files: WorkspaceFile[] | undefined) => void
}

export const useSessionFiles = create<SessionFilesState>((set) => ({
  sessionId: undefined,
  files: undefined,
  publish: (sessionId, files) => { set({ sessionId, files }) },
}))

/**
 * A file the chat itself wrote, as its result: not an upload, not another chat's, not a canvas version or hidden
 * file (.canvas/ snapshots and the like).
 */
export function isChatResult(file: WorkspaceFile, sessionId: string): boolean {
  if (file.origin !== 'chat' || (file.sessionId !== undefined && file.sessionId !== sessionId)) return false
  if (file.path.split('/').some((part) => part.startsWith('.'))) return false
  return !CANVAS_VERSION_RE.test(file.path)
}

// A turn's file box (TurnFiles.tsx) colours each file by type so it reads at a glance (user, 2026-10-28: "html thì
// màu đỏ, csv màu xanh lá"); the usual colour of each format's own app/logo where there is one.
const TYPE_COLORS: { exts: string[]; color: string; Icon: typeof FileGeneric }[] = [
  { exts: ['html', 'htm'], color: '#e34c26', Icon: FileCode2 },
  { exts: ['csv', 'tsv', 'xlsx', 'xls', 'parquet'], color: '#16a34a', Icon: FileSpreadsheet },
  { exts: ['pdf'], color: '#b91c1c', Icon: FileType2 },
  { exts: ['docx', 'doc'], color: '#2b579a', Icon: FileText },
  { exts: ['pptx', 'ppt'], color: '#d24726', Icon: FileType2 },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'], color: '#db2777', Icon: FileImage },
  { exts: ['md', 'markdown'], color: '#7c3aed', Icon: FileText },
  { exts: ['json', 'yaml', 'yml', 'xml', 'toml'], color: '#ca8a04', Icon: FileCode2 },
  { exts: ['py'], color: '#3776ab', Icon: FileCode2 },
  { exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'], color: '#d97706', Icon: FileCode2 },
  { exts: ['sql'], color: '#0891b2', Icon: FileCode2 },
  { exts: ['css', 'scss'], color: '#2563eb', Icon: FileCode2 },
  { exts: ['txt', 'log'], color: '#64748b', Icon: FileText },
]

export function fileType(path: string): { Icon: typeof FileGeneric; color: string; label: string } {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  const ext = dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
  const match = TYPE_COLORS.find((entry) => entry.exts.includes(ext))
  return { Icon: match?.Icon ?? FileGeneric, color: match?.color ?? '#64748b', label: ext ? ext.toUpperCase() : 'FILE' }
}

export function fileKind(path: string): { Icon: typeof FileGeneric; tone: string } {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (['.csv', '.tsv', '.xlsx', '.xls', '.parquet'].includes(ext)) return { Icon: FileSpreadsheet, tone: 'text-status-success' }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return { Icon: FileImage, tone: 'text-accent' }
  if (ext === '.pdf') return { Icon: FileType2, tone: 'text-status-danger' }
  if (['.py', '.js', '.ts', '.json', '.html', '.sql', '.sh'].includes(ext)) return { Icon: FileCode2, tone: 'text-muted' }
  if (['.md', '.txt', '.docx'].includes(ext)) return { Icon: FileText, tone: 'text-accent-text' }
  return { Icon: FileGeneric, tone: 'text-muted' }
}
