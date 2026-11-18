import { HttpError } from "./errors.js";
import {
  assertAzureDevOpsParameterPolicy,
  assertAzureDevOpsProjectContext,
  completeAzureDevOpsParameterPolicy,
  createDefaultAzureDevOpsParameterPolicy,
} from "./policy.js";
import type {
  AzureDevOpsEffectiveContext,
  AzureDevOpsJsonValue,
  AzureDevOpsParameterPolicy,
} from "./types.js";

const ORGANIZATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|credential|private[-_]?key|(?:^|[^a-z0-9])pat(?:$|[^a-z0-9]))/i;

export function resolveAzureDevOpsEffectiveContext(input: {
  settings: unknown;
  openCodeProject: string;
}): AzureDevOpsEffectiveContext {
  if (!input.openCodeProject.trim()) throw new HttpError(400, "OpenCode project identity is required", "AZURE_DEVOPS_OPENCODE_PROJECT_REQUIRED");
  const persisted = readAzureDevOpsContextDocument(input.settings);
  assertSecretSafeContextPatch(persisted);
  const adoProject = stringValue(persisted.project);
  const parameterPolicy = assertAzureDevOpsParameterPolicy(
    completeAzureDevOpsParameterPolicy(persisted.parameterPolicy ?? createDefaultAzureDevOpsParameterPolicy(adoProject), adoProject),
    adoProject,
  );
  assertAzureDevOpsProjectContext(parameterPolicy, adoProject);
  const organization = readOrganization(persisted.organization);
  const context = sanitizeRecord({ ...persisted, ...(adoProject ? { project: adoProject } : {}), parameterPolicy });

  return {
    ...(adoProject ? { adoProject } : {}),
    context,
    openCodeProject: input.openCodeProject,
    ...(organization ? { organization } : {}),
    parameterPolicy,
    version: 1,
  };
}

export function withAzureDevOpsRuntimeContext(
  input: Record<string, unknown>,
  extensionSettings: unknown,
  openCodeProject: string,
): Record<string, unknown> {
  const result = { ...input };
  delete result.azureDevOpsContext;
  if (!isRecord(extensionSettings) || !isRecord(extensionSettings.azureDevOps)) return result;
  return {
    ...result,
    azureDevOpsContext: resolveAzureDevOpsEffectiveContext({
      settings: extensionSettings.azureDevOps,
      openCodeProject,
    }),
  };
}

export function mergeAzureDevOpsContext(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, AzureDevOpsJsonValue> {
  if (Object.prototype.hasOwnProperty.call(patch, "openCodeProject")) {
    throw new HttpError(400, "OpenCode project identity is managed by Agent System", "AZURE_DEVOPS_OPENCODE_PROJECT_READ_ONLY");
  }
  assertSecretSafeContextPatch(patch);
  const next = { ...current, ...patch };
  const adoProject = stringValue(next.project);
  let parameterPolicy: AzureDevOpsParameterPolicy | undefined;
  if (Object.prototype.hasOwnProperty.call(patch, "parameterPolicy")) {
    parameterPolicy = assertAzureDevOpsParameterPolicy(
      completeAzureDevOpsParameterPolicy(patch.parameterPolicy, adoProject),
      adoProject,
    );
    next.parameterPolicy = parameterPolicy;
  } else if (next.parameterPolicy !== undefined) {
    parameterPolicy = assertAzureDevOpsParameterPolicy(
      completeAzureDevOpsParameterPolicy(next.parameterPolicy, adoProject),
      adoProject,
    );
    next.parameterPolicy = parameterPolicy;
  }
  if (parameterPolicy) assertAzureDevOpsProjectContext(parameterPolicy, adoProject);
  if (next.organization !== undefined) next.organization = readOrganization(next.organization);
  return sanitizeRecord(next);
}

export function readAzureDevOpsContextDocument(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return { ...value };
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return { ...parsed };
  } catch {
    throw new HttpError(400, "Azure DevOps context settings must contain valid JSON", "AZURE_DEVOPS_CONTEXT_INVALID");
  }
  throw new HttpError(400, "Azure DevOps context settings must be an object", "AZURE_DEVOPS_CONTEXT_INVALID");
}

function assertSecretSafeContextPatch(value: unknown, path = "context"): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    if (typeof value === "string" && /(?:pat[-_]|bearer\s+|token[-_]|secret[-_])/i.test(value)) {
      throw new HttpError(400, "Plaintext credentials are not allowed in Azure DevOps context", "AZURE_DEVOPS_PLAINTEXT_SECRET");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretSafeContextPatch(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) throw new HttpError(400, "Azure DevOps context must contain JSON values", "AZURE_DEVOPS_CONTEXT_INVALID");
  for (const [key, child] of Object.entries(value)) {
    if (key === "parameterPolicy") continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new HttpError(400, `Secret-bearing context field is not allowed: ${key}`, "AZURE_DEVOPS_PLAINTEXT_SECRET");
    }
    assertSecretSafeContextPatch(child, `${path}.${key}`);
  }
}

function readOrganization(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const organization = typeof value === "string" ? value.trim() : "";
  if (!ORGANIZATION_PATTERN.test(organization)) {
    throw new HttpError(400, "Azure DevOps organization is invalid", "AZURE_DEVOPS_ORGANIZATION_INVALID");
  }
  return organization;
}

function sanitizeRecord(value: unknown): Record<string, AzureDevOpsJsonValue> {
  const sanitized = sanitizeAzureDevOpsJson(value);
  return isJsonRecord(sanitized) ? sanitized : {};
}

export function sanitizeAzureDevOpsJson(value: unknown, key = ""): AzureDevOpsJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : value.slice(0, 200_000);
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => sanitizeAzureDevOpsJson(item, key));
  if (isRecord(value)) {
    const result: Record<string, AzureDevOpsJsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 2_000)) {
      result[childKey] = sanitizeAzureDevOpsJson(childValue, childKey);
    }
    return result;
  }
  return "[REDACTED]";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: AzureDevOpsJsonValue): value is { [key: string]: AzureDevOpsJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
