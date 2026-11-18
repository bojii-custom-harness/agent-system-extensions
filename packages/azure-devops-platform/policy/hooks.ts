import { HttpError } from "./errors.js";
import { mergeAzureDevOpsContext, withAzureDevOpsRuntimeContext, resolveAzureDevOpsEffectiveContext } from "./context.js";
import { assertAzureDevOpsProjectContext, resolveAzureDevOpsToolCall } from "./policy.js";
import type { AzureDevOpsToolName } from "./types.js";

const paths: Record<string, AzureDevOpsToolName> = {
  "create-repository": "azure_devops_create_repository",
  "lookup-repository": "azure_devops_configure_remote",
  "pull-plan": "azure_devops_git_pull",
  "pull-credential": "azure_devops_git_pull",
  "push-plan": "azure_devops_push",
  "push-credential": "azure_devops_push",
  "clone-repository": "azure_devops_clone_repository",
  "get-git-credential": "azure_devops_clone_repository",
  "list-repositories": "azure_devops_list_repositories",
  "list-pipelines": "azure_devops_list_pipelines",
  "create-pipeline": "azure_devops_create_pipeline",
  "create-pull-request": "azure_devops_create_pull_request",
  "get-pull-request": "azure_devops_get_pull_request",
  "list-pull-requests": "azure_devops_list_pull_requests",
  "list-wikis": "azure_devops_list_wikis",
  "write-wiki-page": "azure_devops_write_wiki_page",
  "create-work-item": "azure_devops_create_work_item",
  "get-work-item": "azure_devops_get_work_item",
  "list-work-item-revisions": "azure_devops_list_work_item_revisions",
  "update-work-item": "azure_devops_update_work_item",
  "publish-pipeline-yaml": "azure_devops_publish_pipeline_yaml",
  "preview-pipeline": "azure_devops_preview_pipeline",
  "run-pipeline": "azure_devops_run_pipeline",
  "get-pipeline-run": "azure_devops_get_pipeline_run",
};

export function normalizeSettings(settings: Record<string, unknown>) {
  if (!Object.hasOwn(settings, "azureDevOps")) return settings;
  if (!isRecord(settings.azureDevOps)) {
    throw new HttpError(400, "Azure DevOps Extension context must be an object", "AZURE_DEVOPS_CONTEXT_INVALID");
  }
  return { ...settings, azureDevOps: mergeAzureDevOpsContext({}, settings.azureDevOps) };
}

export function runtimeContext(settings: Record<string, unknown>, project: string) {
  return { azureDevOpsContext: undefined, ...withAzureDevOpsRuntimeContext({}, settings, project) };
}

/** 將設定與可信 Project 身分解析為工具 context，不信任外部傳入的 resolved values。 */
export function prepareRequest(request: Record<string, any>, { project, settings }: { project?: string; settings: Record<string, unknown> }) {
  const tool = paths[request.path];
  if (!tool) return request;
  if (!project) throw new HttpError(400, "Project is required for Azure DevOps repository tools", "AZURE_DEVOPS_PROJECT_REQUIRED");
  if (!isRecord(settings.azureDevOps)) {
    throw new HttpError(409, "Azure DevOps Extension context is not configured for this project", "AZURE_DEVOPS_CONTEXT_UNAVAILABLE");
  }
  const effectiveContext = resolveAzureDevOpsEffectiveContext({ settings: settings.azureDevOps, openCodeProject: project });
  assertAzureDevOpsProjectContext(effectiveContext.parameterPolicy, effectiveContext.adoProject);
  const body = isRecord(request.body) ? request.body : {};
  if (body.tool !== tool) throw new HttpError(400, "Azure DevOps tool identity does not match the backend path", "AZURE_DEVOPS_TOOL_PATH_MISMATCH");
  if (body.derivedValues !== undefined && !isRecord(body.derivedValues)) {
    throw new HttpError(400, "Azure DevOps derived values must be an object", "AZURE_DEVOPS_DERIVED_VALUES_INVALID");
  }
  const supplied = isRecord(body.derivedValues) ? body.derivedValues : {};
  let agentInput = body.agentInput ?? {};
  if (isRecord(agentInput) && tool === "azure_devops_write_wiki_page"
    && effectiveContext.parameterPolicy.tools[tool]?.fields.wikiIdentifier?.mode === "derived") {
    agentInput = { ...agentInput };
    delete agentInput.wikiIdentifier;
  }
  const resolvedToolCall = resolveAzureDevOpsToolCall(tool, effectiveContext.parameterPolicy, agentInput, {
    organization: effectiveContext.organization,
    ...(effectiveContext.adoProject ? { project: effectiveContext.adoProject } : {}),
    ...(typeof effectiveContext.context.wikiIdentifier === "string" ? { wikiIdentifier: effectiveContext.context.wikiIdentifier } : {}),
    ...(typeof supplied.branch === "string" ? { branch: supplied.branch } : {}),
  }, { purpose: request.path === "get-git-credential" ? "credential-broker" : "repository-operation" });
  if (body.verifiedResolvedValues !== undefined || body.verifiedResolvedSources !== undefined) {
    const values = body.verifiedResolvedValues;
    const sources = body.verifiedResolvedSources;
    if (!isRecord(values) || !isRecord(sources)) invalidPlan();
    const forbidden = (key: string) => key === "remoteUrl" || /(?:authorization|credential|pass(?:word|wd)?|(?:^|[^a-z0-9])pat(?:$|[^a-z0-9])|secret|token)/i.test(key);
    const parameters = Object.fromEntries(Object.entries(resolvedToolCall.parameters).filter(([key]) => !forbidden(key)));
    const expectedSources = Object.fromEntries(Object.entries(resolvedToolCall.sources).filter(([key]) => Object.hasOwn(parameters, key)));
    if (Object.keys(values).some(forbidden) || Object.entries(sources).some(([key, source]) => forbidden(key) || !["fixed", "agent", "derived"].includes(source as string))) invalidPlan();
    if (!sameKeys(values, parameters) || !sameKeys(sources, expectedSources)
      || Object.entries(parameters).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(values[key]) || resolvedToolCall.sources[key] !== sources[key])) {
      throw new HttpError(409, "Azure DevOps verified push plan no longer matches policy", "AZURE_DEVOPS_RESOLVED_PLAN_MISMATCH");
    }
  }
  return { ...request, extensionContext: { azureDevOps: { effectiveContext, resolvedToolCall } } };
}

function invalidPlan(): never {
  throw new HttpError(409, "Azure DevOps verified push plan is invalid", "AZURE_DEVOPS_RESOLVED_PLAN_INVALID");
}
function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>) {
  return JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
