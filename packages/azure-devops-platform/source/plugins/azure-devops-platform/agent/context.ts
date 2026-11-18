import { basename } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function currentOpenCodeProject(input: unknown): string {
  const value = isRecord(input) ? input.project : undefined;
  const directory = isRecord(input) && typeof input.directory === "string" ? input.directory : undefined;
  const project = typeof value === "string"
    ? value
    : isRecord(value) && typeof value.name === "string"
      ? value.name
      : process.env.AGENT_SYSTEM_PROJECT || (directory ? basename(directory) : undefined);
  if (typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(project.trim())) {
    throw pluginError("AZURE_DEVOPS_OPENCODE_PROJECT_REQUIRED", "The current OpenCode project identity is required.");
  }
  return project.trim();
}
