// Wire protocol shared by every component in this ONE app (mirrors
// services/gateway's real relay of packages/transport/src/server.ts's real
// shapes, and the real SessionEvent envelope from @deepseek-ai/dsh-session —
// see docs/code-rules.md for how these were confirmed against real installed
// .d.ts files). Used to live duplicated across separate packages ("mirrored,
// not imported" — each bundle was independently loaded from a different
// origin and couldn't share a module graph); now that the whole per-session
// UI-plugin delivery mechanism is gone (2026-09-08 — see apps/web/README.md)
// and this is a single normally-built app, one shared file is simply
// correct, not a compromise.

// `cancel`: the composer's Stop button — aborts the running turn.
export type ClientToServer = { type: 'followup'; text: string } | { type: 'steer'; text: string } | { type: 'cancel' }

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
}

export type ServerToClient =
  | { type: 'session'; sessionId: string }
  | { type: 'snapshot'; events: SessionEvent[] }
  | { type: 'event'; event: SessionEvent }
  | { type: 'error'; message: string }

export interface TextBlock {
  type: 'text'
  text: string
}
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}
export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}
export interface OtherBlock {
  type: string
}
export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock | OtherBlock

export interface WireMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: string }
