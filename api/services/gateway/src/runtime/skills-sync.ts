// Writes a user's skills into the working directory of each of their sessions: `<cwd>/.dsh/skills/<name>/SKILL.md`.
// dsh-skill-filesystem treats `<cwd>/.dsh/skills` as that workspace's project skills (nearest `.git` ancestor or
// the cwd itself — the data dir is checked to be outside any checkout) and watches it live, so a file written
// while a session is running reaches the model on its next step. One runtime serves every user, so the old
// location, the global `$DSH_HOME/skills`, would have shown one user's skills to all the others.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillFile } from '@fox-harness/contracts'

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
    // Skip unchanged files: every change the watcher sees makes dsh append a full replacement catalog to the conversation.
    if ((await readFile(file, 'utf8').catch(() => undefined)) === next) continue
    await mkdir(skillDir, { recursive: true })
    await writeFile(`${file}.tmp`, next)
    await rename(`${file}.tmp`, file)
  }
}

/** Replace the skills of every listed working directory with exactly `skills`; returns how many were written. */
export async function syncSkills(cwds: Iterable<string>, skills: SkillFile[]): Promise<number> {
  let written = 0
  for (const cwd of new Set(cwds)) {
    await writeSkillsDir(join(cwd, '.dsh', 'skills'), skills)
    written += 1
  }
  return written
}
