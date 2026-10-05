// Data-side operations the orchestrator used to do for the gateway, now plain calls: delete a session's data,
// delete a project's, locate a working directory.

import { stat } from 'node:fs/promises'

import type { SessionRuntimeInfo } from '../db.ts'
import { config } from '../config.ts'
import { placementFor, projectDirFor, removeSessionLogs, removeTree, sessionDir } from './paths.ts'
import type { RuntimeSupervisor } from './supervisor.ts'

/**
 * Right-to-erasure delete of one chat: the runtime lets go of it first (otherwise a late log flush would
 * write it back), then its workspace and its dsh log are removed. A project chat's workspace is the
 * project's shared folder, which a single chat's delete must not touch.
 */
export async function purgeSessionData(
  runtime: RuntimeSupervisor,
  sessionId: string,
  info: Pick<SessionRuntimeInfo, 'ownerId' | 'projectId'>,
): Promise<void> {
  await runtime.drop(sessionId)
  await removeSessionLogs(sessionId)
  if (info.projectId === undefined) await removeTree(sessionDir(info.ownerId, sessionId))
}

export async function deleteProjectData(projectId: string): Promise<void> {
  const dir = projectDirFor(projectId)
  if (!dir) throw new Error('invalid project id')
  await removeTree(dir)
}

/** The working directory the files API may list/serve for a session, or undefined for a chat without one. */
export function workspaceDirForSession(info: Pick<SessionRuntimeInfo, 'ownerId' | 'projectId' | 'flow'>, sessionId: string): string | undefined {
  const flow = config.flows[info.flow as keyof typeof config.flows]
  if (info.projectId === undefined && !flow?.workspace) return undefined
  return placementFor(info, sessionId).cwd
}

export async function dirExists(dir: string): Promise<boolean> {
  return (await stat(dir).catch(() => undefined))?.isDirectory() ?? false
}
