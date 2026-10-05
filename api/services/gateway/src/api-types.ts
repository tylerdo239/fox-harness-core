// Shapes of the gateway's HTTP API (was api/services/gateway/src/api-types.ts). The web UI keeps its own copy
// (app/src/wire.ts, skillsApi.ts, workspaceApi.ts): app/ imports nothing from api/.

// Per-user skills (docs/skill-transfer-plan.md). Gateway owns them (MariaDB
// `discovery_custom_skills`, content on S3) and writes the rendered files into each of the user's
// working directories (services/gateway/src/runtime/skills-sync.ts).
export interface SkillFile {
  name: string
  description: string
  content: string
}

// Data-analysis working directory (docs/rlm-transfer-plan.md giai đoạn 4):
// GET /sessions/:id/files on the gateway.
export interface WorkspaceFile {
  // Relative to the working directory, `/`-separated.
  path: string
  sizeBytes: number
  modified: string
  // `source` a user upload (recorded in `.fox/sources.json`), `shared` an output promoted to
  // `outputs/`, `chat` anything a chat wrote.
  origin: 'source' | 'shared' | 'chat'
  // The chat whose output folder (`generated/<sessionId>/`) holds the file, when known.
  sessionId?: string
}

export interface WorkspaceFilesResponse {
  files: WorkspaceFile[]
}

// POST /projects/:id/promote (docs/rlm-transfer-plan.md 9.1, "Đưa vào dự án"):
// copy one chat's output, `generated/<sessionId>/<path>`, into the project's
// shared `outputs/` folder.
export interface ProjectPromoteRequest {
  sessionId: string
  path: string
}
