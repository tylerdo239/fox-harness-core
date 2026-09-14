// Writes a user's skills into <dshHomeDir>/skills/<name>/SKILL.md for each
// listed session. That directory is dsh-skill-filesystem's `user-dsh` root and
// it is watched live: a file written while the container is already running
// (warm-pool claim, edit from the Skills tab) reaches the model on its next
// step — verified ~30ms, docs/skill-transfer-plan.md §2.
//
// Never learns whose skills these are: gateway sends session ids + files only.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillFile } from '@fox-harness/contracts'

import { getSession } from './redis.ts'

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name)
}

// This repo has no YAML library. A JSON string is a valid YAML double-quoted
// scalar, so a `:` or `#` in the description can't break the frontmatter —
// dsh drops a skill whose frontmatter fails to parse, with only a log warning.
function renderSkill(skill: SkillFile): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trimEnd()}\n`
}

async function writeSkillsDir(dir: string, skills: SkillFile[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const wanted = new Set(skills.map((skill) => skill.name))
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!wanted.has(entry.name)) await rm(join(dir, entry.name), { recursive: true, force: true })
  }
  for (const skill of skills) {
    const skillDir = join(dir, skill.name)
    const file = join(skillDir, 'SKILL.md')
    const next = renderSkill(skill)
    // Skip unchanged files: every change the watcher sees makes dsh append a
    // full replacement catalog to the conversation.
    if ((await readFile(file, 'utf8').catch(() => undefined)) === next) continue
    await mkdir(skillDir, { recursive: true })
    await writeFile(`${file}.tmp`, next)
    await rename(`${file}.tmp`, file)
  }
}

export async function syncSkills(sessionIds: string[], skills: SkillFile[]): Promise<string[]> {
  const synced: string[] = []
  for (const sessionId of sessionIds) {
    const record = await getSession(sessionId)
    if (!record || record.status === 'archived') continue
    await writeSkillsDir(join(record.dshHomeDir, 'skills'), skills)
    synced.push(sessionId)
  }
  return synced
}
