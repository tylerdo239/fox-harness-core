// Writes the files the runtime process boots from. Unlike the orchestrator's per-session materialization
// there is exactly ONE profile now, shared by every runtime process and every session, so this runs once at
// start-up and always overwrites: the profile is code, not user data.

import { copyFile, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { config } from '../config.ts'
import { dshHome } from './paths.ts'

export const PROFILE_NAME = 'fox-harness'

const templateDir = join(config.repoRoot, 'packages/profile-template/runtime/template')

async function link(target: string, path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await symlink(target, path)
}

export async function materializeProfile(): Promise<void> {
  const home = dshHome()
  const profile = join(home, 'profiles', PROFILE_NAME)
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await copyFile(join(templateDir, 'profile.package.json'), join(profile, 'package.json'))
  await copyFile(join(templateDir, 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'))
  // `@fox-harness/*` bundles are not auto-resolved from the profile dir the way `@deepseek-ai/*` ones are.
  await link(join(config.repoRoot, 'node_modules/@fox-harness'), join(profile, 'node_modules/@fox-harness'))
  // Where the agent-presets service finds our flow presets (see the profile's `agent-presets` row).
  await link(join(config.repoRoot, 'packages/profile-template/presets'), join(home, '.agent-presets'))
}
