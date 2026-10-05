// Per-user skill rules + the built-in skill list (docs/skill-transfer-plan.md).
// Gateway is the authority for both: it validates what users save, refuses
// names that would silently shadow a built-in skill (a `user-dsh` skill beats
// a `bundled` one in dsh-skill-filesystem), and builds the "/" menu.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SkillFile } from '@fox-harness/contracts'

export const MAX_SKILLS_PER_USER = 50
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const MAX_DESCRIPTION_CHARS = 280
const MAX_CONTENT_BYTES = 64 * 1024

export interface BuiltinSkill {
  name: string
  description: string
  userInvocable: boolean
}

// packages/skills is baked into the worker image from this same repo, so this
// is the list every worker loads. A plain file read, not an import (§1).
const SKILLS_DIR = fileURLToPath(new URL('../../../packages/skills', import.meta.url))

function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const fields: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    try {
      fields[match[1]] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
    } catch {
      fields[match[1]] = raw
    }
  }
  return fields
}

export function loadBuiltinSkills(): BuiltinSkill[] {
  const skills: BuiltinSkill[] = []
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let text: string
    try {
      text = readFileSync(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const fields = frontmatter(text)
    if (!fields.name || !fields.description) continue
    skills.push({
      name: fields.name,
      description: fields.description,
      userInvocable: !/^(false|no|off|0)$/i.test(fields['user-invocable'] ?? ''),
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export type SkillValidation = { ok: true; skill: SkillFile } | { ok: false; code: string; error: string }

// `name` comes from the URL on update (renaming is not supported), from the
// body on create.
export function validateSkill(name: unknown, body: { description?: unknown; content?: unknown }, builtinNames: Set<string>): SkillValidation {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, code: 'invalid_skill_name', error: 'name must be kebab-case: ^[a-z0-9][a-z0-9-]{1,63}$' }
  }
  if (builtinNames.has(name)) {
    return { ok: false, code: 'skill_name_reserved', error: `"${name}" is a built-in skill name` }
  }
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description || description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, code: 'invalid_skill_description', error: `description is required, at most ${MAX_DESCRIPTION_CHARS} characters` }
  }
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { ok: false, code: 'invalid_skill_content', error: `content is required, at most ${MAX_CONTENT_BYTES} bytes` }
  }
  return { ok: true, skill: { name, description, content } }
}
