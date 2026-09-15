// Projects (docs/rlm-transfer-plan.md 9.1): a named folder of data shared by
// its data-analysis chats. Mirrors services/gateway's /projects shapes.

import type { Runtime } from "../../../runtime.ts";

export interface Project {
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectChat {
  sessionId: string;
  title: string | null;
  updatedAt: string;
}

// Same limit as services/gateway (projects.name varchar(120)).
export const PROJECT_NAME_MAX = 120;

async function send(runtime: Runtime, path: string, method: string, body?: unknown): Promise<Response> {
  const res = await runtime.authedFetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export async function listProjects(runtime: Runtime): Promise<Project[]> {
  return ((await (await send(runtime, "/projects", "GET")).json()) as { projects: Project[] }).projects;
}

export async function createProject(runtime: Runtime, name: string): Promise<Project> {
  return (await (await send(runtime, "/projects", "POST", { name })).json()) as Project;
}

export async function renameProject(runtime: Runtime, projectId: string, name: string): Promise<void> {
  await send(runtime, `/projects/${projectId}`, "PATCH", { name });
}

export async function deleteProject(runtime: Runtime, projectId: string): Promise<void> {
  await send(runtime, `/projects/${projectId}`, "DELETE");
}

// XMLHttpRequest rather than fetch: fetch reports no upload progress.
export function uploadProjectFile(
  runtime: Runtime,
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", runtime.apiUrl(`/projects/${projectId}/files?name=${encodeURIComponent(file.name)}`));
    for (const [name, value] of Object.entries(runtime.authHeaders())) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

// "Đưa vào dự án": copies a chat's output (`generated/<sessionId>/<path>`) to the project's outputs/.
export async function promoteProjectOutput(runtime: Runtime, projectId: string, sessionId: string, path: string): Promise<void> {
  await send(runtime, `/projects/${projectId}/promote`, "POST", { sessionId, path });
}

export async function listProjectChats(runtime: Runtime, projectId: string): Promise<ProjectChat[]> {
  return ((await (await send(runtime, `/projects/${projectId}/sessions`, "GET")).json()) as { sessions: ProjectChat[] }).sessions;
}
