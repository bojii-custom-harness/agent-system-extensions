import { HttpError } from "./errors.js";
import {
  AZURE_DEVOPS_TOOL_NAMES,
  type AzureDevOpsJsonValue,
  type AzureDevOpsParameterDefinition,
  type AzureDevOpsParameterPolicy,
  type AzureDevOpsPolicyIssue,
  type AzureDevOpsPolicyMode,
  type AzureDevOpsResolvedToolCall,
  type AzureDevOpsToolName,
  type AzureDevOpsToolParameterPolicy,
  type AzureDevOpsPolicyValidation,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NON_EMPTY_STRING_MAX_LENGTH = 2_000;
const ENVIRONMENT_REFERENCE_PATTERN = /^\{env:[A-Z_][A-Z0-9_]*\}$/;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|credential|private[-_]?key|(?:^|[^a-z0-9])pat(?:$|[^a-z0-9]))/i;

const COMMON_CONTEXT_PARAMETER_DEFINITIONS = {
  organization: derived("string"),
  project: fixed("string", true),
};
const FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS = {
  ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
  project: { ...COMMON_CONTEXT_PARAMETER_DEFINITIONS.project, forcedMode: "fixed" as const },
};
const REPOSITORY_IDENTITY_PARAMETER_DEFINITIONS = {
  repositoryReference: agent("string"),
  repositoryID: agent("uuid"),
  repositoryName: agent("string"),
};
const DERIVED_REPOSITORY_PARAMETER_DEFINITIONS = {
  repositoryReference: derived("string"),
  remoteUrl: derived("string"),
  credential: derived("string"),
};
const PIPELINE_REPOSITORY_IDENTITY_PARAMETER_DEFINITIONS = {
  repositoryReference: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 300 },
  repositoryID: { ...agent("uuid"), allowedModes: ["agent", "fixed"] as const },
  repositoryName: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 128 },
};
const FIXED_REMOTE_NAME_PARAMETER_DEFINITIONS = {
  remoteName: fixed("string", false, "origin"),
};
const DERIVED_REMOTE_NAME_PARAMETER_DEFINITIONS = {
  remoteName: derived("string"),
};
const PIPELINE_ID_PARAMETER_DEFINITION = {
  ...agent("integer", true),
  maximum: 2_147_483_647,
  requiredAlways: true,
};
const PIPELINE_BRANCH_REF_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("string"),
  allowedModes: ["agent", "fixed"],
  maxLength: 255,
  parameterFormat: "azure-devops-branch-ref",
};
const PULL_REQUEST_BRANCH_REF_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("string", true),
  allowedModes: ["agent", "fixed"],
  maxLength: 255,
  parameterFormat: "azure-devops-branch-ref",
  requiredAlways: true,
};
const PULL_REQUEST_LIST_BRANCH_REF_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("string"),
  allowedModes: ["agent", "fixed"],
  maxLength: 255,
  parameterFormat: "azure-devops-branch-ref",
};
const PULL_REQUEST_LIST_STATUS_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("string"),
  allowedModes: ["agent", "fixed"],
  maxLength: 16,
  parameterFormat: "azure-devops-pull-request-status",
};
const PULL_REQUEST_LIST_TOP_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("integer"),
  allowedModes: ["agent", "fixed"],
  minimum: 1,
  maximum: 100,
};
const PULL_REQUEST_LIST_SKIP_PARAMETER_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("integer"),
  allowedModes: ["agent", "fixed"],
  minimum: 0,
  maximum: 2_147_483_647,
};
const PIPELINE_TEMPLATE_PARAMETERS_DEFINITION: AzureDevOpsParameterDefinition = {
  ...agent("pipeline-template-parameters"),
  allowedModes: ["agent", "fixed"],
};
const PULL_REQUEST_LIST_PARAMETER_DEFINITIONS = {
  reviewerIds: array("uuid", 50),
  workItemIds: array("integer", 50, { itemMinimum: 1, itemMaximum: 2_147_483_647 }),
  labels: array("string", 50, { itemMaximumLength: 128 }),
};
const PULL_REQUEST_LIST_FIELDS = Object.keys(PULL_REQUEST_LIST_PARAMETER_DEFINITIONS);
const PULL_REQUEST_LIST_SERIALIZED_MAX_LENGTH = 10_000;
const PIPELINE_RUN_PARAMETER_DEFINITIONS = {
  ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
  pipelineId: PIPELINE_ID_PARAMETER_DEFINITION,
  branchRef: PIPELINE_BRANCH_REF_PARAMETER_DEFINITION,
  templateParameters: PIPELINE_TEMPLATE_PARAMETERS_DEFINITION,
};

const WORK_ITEM_MUTABLE_FIELD_PARAMETER_DEFINITIONS: Record<string, AzureDevOpsParameterDefinition> = {
  workItemType: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 128 },
  title: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 255 },
  description: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 100_000 },
  areaPath: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 2_048 },
  iterationPath: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 2_048 },
  assignedTo: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 512 },
  priority: { ...agent("integer"), allowedModes: ["agent", "fixed"] },
  tags: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 4_000 },
  state: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 128 },
  reproSteps: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 100_000 },
  systemInfo: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 100_000 },
  severity: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 128 },
  acceptanceCriteria: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 100_000 },
  originalEstimate: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  remainingWork: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  completedWork: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  activity: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 128 },
  storyPoints: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  effort: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  size: { ...agent("number"), allowedModes: ["agent", "fixed"], minimum: 0 },
  businessValue: { ...agent("integer"), allowedModes: ["agent", "fixed"], minimum: 0 },
};

export const AZURE_DEVOPS_PARAMETER_DEFINITIONS: Record<AzureDevOpsToolName, Record<string, AzureDevOpsParameterDefinition>> = {
  azure_devops_create_repository: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryName: agent("string", true),
    ...DERIVED_REPOSITORY_PARAMETER_DEFINITIONS,
  },
  azure_devops_configure_remote: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    ...REPOSITORY_IDENTITY_PARAMETER_DEFINITIONS,
    repositoryPath: {
      allowedModes: ["fixed", "agent"],
      defaultMode: "agent",
      maxLength: 1_024,
      parameterFormat: "project-repository-path",
      parameterType: "string",
    },
    ...FIXED_REMOTE_NAME_PARAMETER_DEFINITIONS,
    updateExisting: agent("boolean"),
    remoteUrl: derived("string"),
    credential: derived("string"),
  },
  azure_devops_git_pull: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryPath: {
      allowedModes: ["fixed", "agent"],
      defaultMode: "agent",
      maxLength: 1_024,
      parameterFormat: "project-repository-path",
      parameterType: "string",
      required: true,
      requiredAlways: true,
    },
    ...FIXED_REMOTE_NAME_PARAMETER_DEFINITIONS,
    branch: agent("string"),
    remoteUrl: derived("string"),
    credential: derived("string"),
  },
  azure_devops_push: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryPath: {
      allowedModes: ["fixed", "agent"],
      defaultMode: "agent",
      maxLength: 1_024,
      parameterFormat: "project-repository-path",
      parameterType: "string",
      required: true,
      requiredAlways: true,
    },
    ...FIXED_REMOTE_NAME_PARAMETER_DEFINITIONS,
    branch: agent("string", true),
    setUpstream: agent("boolean"),
    remoteUrl: derived("string"),
    credential: derived("string"),
  },
  azure_devops_clone_repository: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    ...REPOSITORY_IDENTITY_PARAMETER_DEFINITIONS,
    branch: agent("string"),
    ref: agent("string"),
    depth: agent("integer"),
    destination: agent("string"),
    ...DERIVED_REMOTE_NAME_PARAMETER_DEFINITIONS,
    remoteUrl: derived("string"),
    credential: derived("string"),
  },
  azure_devops_list_repositories: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
  },
  azure_devops_list_pipelines: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    continuationToken: { ...agent("string"), allowedModes: ["agent"] as const, maxLength: 2_000 },
  },
  azure_devops_create_pipeline: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    ...PIPELINE_REPOSITORY_IDENTITY_PARAMETER_DEFINITIONS,
    name: { ...agent("string", true), allowedModes: ["agent", "fixed"] as const, maxLength: 128, requiredAlways: true },
    yamlPath: { ...agent("string", true), allowedModes: ["agent", "fixed"] as const, maxLength: 1_024, parameterFormat: "repository-yaml-path", requiredAlways: true },
    folder: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 512, parameterFormat: "pipeline-folder" },
  },
  azure_devops_create_pull_request: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryReference: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 300, parameterFormat: "azure-devops-repository-reference" },
    repositoryID: { ...agent("uuid"), allowedModes: ["agent", "fixed"] as const },
    repositoryName: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 128, parameterFormat: "azure-devops-repository-name" },
    sourceRefName: PULL_REQUEST_BRANCH_REF_PARAMETER_DEFINITION,
    targetRefName: PULL_REQUEST_BRANCH_REF_PARAMETER_DEFINITION,
    title: { ...agent("string", true), allowedModes: ["agent", "fixed"] as const, maxLength: 255, requiredAlways: true },
    description: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, allowEmpty: true, maxLength: 100_000 },
    isDraft: { ...agent("boolean"), allowedModes: ["agent", "fixed"] as const },
    ...PULL_REQUEST_LIST_PARAMETER_DEFINITIONS,
    supportsIterations: { ...agent("boolean"), allowedModes: ["agent", "fixed"] as const },
  },
  azure_devops_get_pull_request: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    pullRequestId: {
      ...agent("integer", true),
      allowedModes: ["agent", "fixed"] as const,
      minimum: 1,
      maximum: 2_147_483_647,
      requiredAlways: true,
    },
    commitTop: {
      ...agent("integer"),
      allowedModes: ["agent", "fixed"] as const,
      minimum: 1,
      maximum: 100,
    },
    commitContinuationToken: { ...agent("string"), allowedModes: ["agent"] as const, maxLength: 2_000 },
  },
  azure_devops_list_pull_requests: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryReference: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 300, parameterFormat: "azure-devops-repository-reference" },
    repositoryID: { ...agent("uuid"), allowedModes: ["agent", "fixed"] as const },
    repositoryName: { ...agent("string"), allowedModes: ["agent", "fixed"] as const, maxLength: 128, parameterFormat: "azure-devops-repository-name" },
    sourceRefName: PULL_REQUEST_LIST_BRANCH_REF_PARAMETER_DEFINITION,
    targetRefName: PULL_REQUEST_LIST_BRANCH_REF_PARAMETER_DEFINITION,
    status: PULL_REQUEST_LIST_STATUS_PARAMETER_DEFINITION,
    top: PULL_REQUEST_LIST_TOP_PARAMETER_DEFINITION,
    skip: PULL_REQUEST_LIST_SKIP_PARAMETER_DEFINITION,
  },
  azure_devops_list_wikis: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
  },
  azure_devops_write_wiki_page: {
    ...COMMON_CONTEXT_PARAMETER_DEFINITIONS,
    wikiIdentifier: {
      allowedModes: ["agent", "fixed", "derived"],
      defaultMode: "derived",
      maxLength: 256,
      parameterType: "string",
      required: true,
      requiredAlways: true,
    },
    path: { ...agent("string", true), allowedModes: ["agent", "fixed"], maxLength: 2_048, requiredAlways: true },
    content: { ...agent("string", true), allowedModes: ["agent", "fixed"], maxLength: 100_000, requiredAlways: true },
    comment: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 1_000 },
  },
  azure_devops_create_work_item: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    ...WORK_ITEM_MUTABLE_FIELD_PARAMETER_DEFINITIONS,
    workItemType: {
      ...WORK_ITEM_MUTABLE_FIELD_PARAMETER_DEFINITIONS.workItemType,
      ...agent("string", true),
      allowedModes: ["agent", "fixed"],
      maxLength: 128,
      requiredAlways: true,
    },
    title: {
      ...WORK_ITEM_MUTABLE_FIELD_PARAMETER_DEFINITIONS.title,
      ...agent("string", true),
      allowedModes: ["agent", "fixed"],
      maxLength: 255,
      requiredAlways: true,
    },
    parentId: { ...agent("integer"), allowedModes: ["agent", "fixed"], maxValue: 2_147_483_647 },
  },
  azure_devops_get_work_item: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    workItemId: {
      ...agent("integer", true),
      allowedModes: ["agent", "fixed"],
      minimum: 1,
      maximum: 2_147_483_647,
      requiredAlways: true,
    },
  },
  azure_devops_list_work_item_revisions: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    workItemId: {
      ...agent("integer", true),
      allowedModes: ["agent", "fixed"],
      minimum: 1,
      maximum: 2_147_483_647,
      requiredAlways: true,
    },
    top: {
      ...agent("integer"),
      allowedModes: ["agent", "fixed"],
      minimum: 1,
      maximum: 20,
    },
    skip: {
      ...agent("integer"),
      allowedModes: ["agent", "fixed"],
      minimum: 0,
      maximum: 2_147_483_647,
    },
  },
  azure_devops_update_work_item: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    workItemId: {
      ...agent("integer", true),
      allowedModes: ["agent", "fixed"],
      minimum: 1,
      maximum: 2_147_483_647,
      requiredAlways: true,
    },
    expectedRev: {
      ...agent("integer"),
      allowedModes: ["agent"],
      minimum: 1,
      maximum: 2_147_483_647,
    },
    ...WORK_ITEM_MUTABLE_FIELD_PARAMETER_DEFINITIONS,
  },
  azure_devops_publish_pipeline_yaml: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    repositoryReference: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 300 },
    repositoryID: { ...agent("uuid"), allowedModes: ["agent", "fixed"] },
    repositoryName: { ...agent("string"), allowedModes: ["agent", "fixed"], maxLength: 128 },
    path: {
      ...agent("string", true),
      allowedModes: ["agent", "fixed"],
      maxLength: 1_024,
      parameterFormat: "pipeline-yaml-path",
      requiredAlways: true,
    },
    yamlContent: {
      ...agent("string", true),
      forcedMode: "agent",
      maxLength: 100_000,
      requiredAlways: true,
    },
  },
  azure_devops_preview_pipeline: {
    ...PIPELINE_RUN_PARAMETER_DEFINITIONS,
  },
  azure_devops_run_pipeline: {
    ...PIPELINE_RUN_PARAMETER_DEFINITIONS,
  },
  azure_devops_get_pipeline_run: {
    ...FIXED_PROJECT_CONTEXT_PARAMETER_DEFINITIONS,
    pipelineId: PIPELINE_ID_PARAMETER_DEFINITION,
    runId: {
      ...agent("integer", true),
      maximum: 2_147_483_647,
      requiredAlways: true,
    },
  },
};

export function createDefaultAzureDevOpsParameterPolicy(adoProject?: string): AzureDevOpsParameterPolicy {
  const tools = {} as AzureDevOpsParameterPolicy["tools"];
  for (const tool of AZURE_DEVOPS_TOOL_NAMES) {
    const fields: Record<string, { mode: AzureDevOpsPolicyMode; required?: boolean; value?: AzureDevOpsJsonValue }> = {};
    for (const [field, definition] of Object.entries(AZURE_DEVOPS_PARAMETER_DEFINITIONS[tool])) {
      const value = field === "project" ? adoProject : definition.defaultValue;
      fields[field] = {
        mode: definition.forcedMode ?? definition.defaultMode,
        ...(definition.required ? { required: true } : {}),
        ...(value === undefined ? {} : { value }),
      };
    }
    tools[tool] = { fields };
  }
  return { version: 1, tools };
}

export function completeAzureDevOpsParameterPolicy(value: unknown, adoProject?: string): unknown {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.tools)) return value;

  const defaults = createDefaultAzureDevOpsParameterPolicy(adoProject);
  const tools = { ...value.tools };
  for (const tool of AZURE_DEVOPS_TOOL_NAMES) {
    const defaultTool = defaults.tools[tool];
    if (!Object.prototype.hasOwnProperty.call(tools, tool)) {
      tools[tool] = defaultTool;
      continue;
    }

    const rawTool = tools[tool];
    if (!isRecord(rawTool) || !isRecord(rawTool.fields)) continue;

    const fields = { ...rawTool.fields };
    for (const [field, defaultField] of Object.entries(defaultTool.fields)) {
      if (!Object.prototype.hasOwnProperty.call(fields, field)) {
        fields[field] = defaultField;
        continue;
      }

      const rawField = fields[field];
      if (!isRecord(rawField)
        || (rawField.mode ?? defaultField.mode) !== "fixed"
        || defaultField.mode !== "fixed"
        || Object.prototype.hasOwnProperty.call(rawField, "value")
        || !Object.prototype.hasOwnProperty.call(defaultField, "value")) continue;

      fields[field] = { ...rawField, value: defaultField.value };
    }
    tools[tool] = { ...rawTool, fields };
  }
  return { ...value, tools };
}

export function validateAzureDevOpsParameterPolicy(
  value: unknown,
  adoProject?: string,
): AzureDevOpsPolicyValidation {
  if (!isRecord(value)) {
    return { issues: [{ code: "AZURE_DEVOPS_POLICY_INVALID", message: "Azure DevOps parameter policy must be an object." }] };
  }

  const defaults = createDefaultAzureDevOpsParameterPolicy(adoProject);
  const issues: AzureDevOpsPolicyIssue[] = [];
  if (value.version !== 1) issues.push({ code: "AZURE_DEVOPS_POLICY_VERSION_INVALID", message: "Azure DevOps parameter policy version must be 1." });

  const rawTools = isRecord(value.tools) ? value.tools : undefined;
  if (!rawTools) {
    return { issues: [...issues, { code: "AZURE_DEVOPS_POLICY_TOOLS_REQUIRED", message: "Azure DevOps parameter policy must declare all tools." }] };
  }

  const normalizedTools = {} as AzureDevOpsParameterPolicy["tools"];
  for (const tool of AZURE_DEVOPS_TOOL_NAMES) {
    const definition = AZURE_DEVOPS_PARAMETER_DEFINITIONS[tool];
    const defaultTool = defaults.tools[tool];
    const rawTool = rawTools[tool];
    if (!isRecord(rawTool)) {
      issues.push({ code: "AZURE_DEVOPS_TOOL_POLICY_REQUIRED", field: `tools.${tool}`, message: `Policy for ${tool} is required.` });
      normalizedTools[tool] = defaultTool;
      continue;
    }

    const rawFields = isRecord(rawTool.fields) ? rawTool.fields : undefined;
    if (!rawFields) {
      issues.push({ code: "AZURE_DEVOPS_TOOL_FIELDS_REQUIRED", field: `tools.${tool}.fields`, message: `Fields for ${tool} are required.` });
      normalizedTools[tool] = defaultTool;
      continue;
    }

    for (const field of Object.keys(rawFields)) {
      if (!Object.prototype.hasOwnProperty.call(definition, field)) {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_UNKNOWN", field: `tools.${tool}.fields.${field}`, message: `Unknown Azure DevOps parameter: ${field}.` });
      }
    }

    const normalizedFields: Record<string, { mode: AzureDevOpsPolicyMode; required?: boolean; value?: AzureDevOpsJsonValue }> = {};
    for (const [field, parameterDefinition] of Object.entries(definition)) {
      const rawField = isRecord(rawFields[field]) ? rawFields[field] : undefined;
      const defaultField = defaultTool.fields[field];
      const mode = rawField?.mode ?? defaultField?.mode;
      const hasRequired = rawField !== undefined && Object.prototype.hasOwnProperty.call(rawField, "required");
      const rawRequired = rawField?.required;
      const required = typeof rawRequired === "boolean"
        ? rawRequired
        : defaultField?.required ?? parameterDefinition.required;
      const fieldPath = `tools.${tool}.fields.${field}`;
      if (mode !== "fixed" && mode !== "agent" && mode !== "derived") {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_MODE_INVALID", field: fieldPath, message: `Policy mode for ${field} must be fixed, agent, or derived.` });
        normalizedFields[field] = defaultField ?? { mode: parameterDefinition.defaultMode };
        continue;
      }

      if (parameterDefinition.forcedMode && mode !== parameterDefinition.forcedMode) {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_MODE_FORBIDDEN", field: fieldPath, message: `${field} must remain ${parameterDefinition.forcedMode}.` });
      }
      if (parameterDefinition.allowedModes && !parameterDefinition.allowedModes.includes(mode)) {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_MODE_FORBIDDEN", field: fieldPath, message: `Policy mode for ${field} is not allowed.` });
      }
      if (hasRequired && typeof rawRequired !== "boolean") {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_REQUIRED_INVALID", field: fieldPath, message: `Required flag for ${field} must be a boolean.` });
      }
      if (parameterDefinition.requiredAlways && required !== true) {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_REQUIRED_FORCED", field: fieldPath, message: `${field} must remain required.` });
      } else if (parameterDefinition.required && mode !== "agent" && required !== true) {
        issues.push({ code: "AZURE_DEVOPS_PARAMETER_REQUIRED_FORCED", field: fieldPath, message: `${field} must remain required outside Agent input.` });
      }
      const hasValue = rawField ? Object.prototype.hasOwnProperty.call(rawField, "value") : false;
      const rawValue = rawField?.value;
      if (mode === "fixed") {
        if (!hasValue && field === "project" && adoProject) {
          normalizedFields[field] = { mode, ...(required ? { required: true } : {}), value: adoProject };
          continue;
        }
        if (!hasValue) {
          issues.push({ code: "AZURE_DEVOPS_FIXED_VALUE_REQUIRED", field: fieldPath, message: `Fixed parameter ${field} requires a value.` });
        } else if (containsSecretValue(rawValue, field)) {
          issues.push({ code: "AZURE_DEVOPS_POLICY_SECRET_FORBIDDEN", field: fieldPath, message: `Secret values are not allowed in parameter policy.` });
        } else {
          const valueIssue = validateParameterValue(parameterDefinition, rawValue);
          if (valueIssue) issues.push({ ...valueIssue, field: fieldPath });
        }
      } else if (hasValue) {
        issues.push({
          code: mode === "derived" ? "AZURE_DEVOPS_DERIVED_VALUE_FORBIDDEN" : "AZURE_DEVOPS_AGENT_VALUE_FORBIDDEN",
          field: fieldPath,
          message: `${mode} parameters cannot persist a fixed value.`,
        });
      }

      normalizedFields[field] = {
        mode,
        ...(hasRequired ? { required } : required ? { required: true } : {}),
        ...(mode === "fixed" && hasValue && isAzureDevOpsJsonValue(rawValue) ? { value: rawValue } : {}),
      };
    }
    if (tool === "azure_devops_create_pull_request") {
      const listValues = Object.fromEntries(PULL_REQUEST_LIST_FIELDS.flatMap((field) => {
        const configured = normalizedFields[field];
        return configured?.mode === "fixed" && Object.prototype.hasOwnProperty.call(configured, "value")
          ? [[field, configured.value]]
          : [];
      }));
      if (JSON.stringify(listValues).length > PULL_REQUEST_LIST_SERIALIZED_MAX_LENGTH) {
        issues.push({
          code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID",
          field: `tools.${tool}.fields`,
          message: "Pull request reviewerIds, workItemIds, and labels exceed the combined 10,000 character limit.",
        });
      }
    }
    normalizedTools[tool] = { fields: normalizedFields };
  }

  for (const rawToolName of Object.keys(rawTools)) {
    if (!AZURE_DEVOPS_TOOL_NAMES.includes(rawToolName as AzureDevOpsToolName)) {
      issues.push({ code: "AZURE_DEVOPS_TOOL_UNKNOWN", field: `tools.${rawToolName}`, message: `Unknown Azure DevOps tool: ${rawToolName}.` });
    }
  }

  return {
    issues,
    ...(issues.length === 0 ? { policy: { version: 1, tools: normalizedTools } } : {}),
  };
}

export function assertAzureDevOpsParameterPolicy(
  value: unknown,
  adoProject?: string,
): AzureDevOpsParameterPolicy {
  const result = validateAzureDevOpsParameterPolicy(value, adoProject);
  if (result.issues.length > 0 || !result.policy) {
    throw new HttpError(400, "Azure DevOps parameter policy validation failed", "AZURE_DEVOPS_POLICY_INVALID", { issues: result.issues });
  }
  return result.policy;
}

export function assertAzureDevOpsProjectContext(
  policy: AzureDevOpsParameterPolicy,
  adoProject: string | undefined,
): void {
  for (const tool of AZURE_DEVOPS_TOOL_NAMES) {
    const project = policy.tools[tool]?.fields.project;
    if (project?.mode !== "fixed") continue;
    if (typeof adoProject !== "string" || project.value !== adoProject) {
      throw new HttpError(409, "Azure DevOps fixed project policy does not match the effective ADO project", "AZURE_DEVOPS_PROJECT_CONTEXT_MISMATCH", {
        adoProject,
        fixedProject: project.value,
        tool,
      });
    }
  }
}

export function resolveAzureDevOpsToolCall(
  tool: AzureDevOpsToolName,
  policy: AzureDevOpsParameterPolicy,
  agentInput: unknown,
  derivedValues: Record<string, unknown> = {},
  options: { purpose?: "credential-broker" | "repository-operation" } = {},
): AzureDevOpsResolvedToolCall {
  const definitions = AZURE_DEVOPS_PARAMETER_DEFINITIONS[tool];
  if (!definitions) throw new HttpError(400, "Unknown Azure DevOps tool", "AZURE_DEVOPS_TOOL_UNKNOWN", { tool });
  const normalizedPolicy = assertAzureDevOpsParameterPolicy(policy, fixedProjectFromPolicy(policy, tool));
  const toolPolicy = normalizedPolicy.tools[tool];
  if (!isRecord(agentInput)) throw new HttpError(400, "Azure DevOps tool parameters must be an object", "AZURE_DEVOPS_AGENT_PARAMETERS_INVALID");

  for (const field of Object.keys(agentInput)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, field)) {
      throw new HttpError(400, `Unknown Azure DevOps tool parameter: ${field}`, "AZURE_DEVOPS_AGENT_PARAMETER_UNKNOWN", { field, tool });
    }
  }

  const parameters: Record<string, AzureDevOpsJsonValue> = {};
  const sources: Record<string, "fixed" | "agent" | "derived"> = {};
  for (const [field, definition] of Object.entries(definitions)) {
    const configured = toolPolicy.fields[field];
    if (!configured) continue;
    const supplied = Object.prototype.hasOwnProperty.call(agentInput, field);
    const suppliedValue = agentInput[field];
    if (configured.mode === "fixed") {
      if (supplied && !sameJsonValue(suppliedValue, configured.value)) {
        throw new HttpError(400, `Fixed Azure DevOps parameter cannot be overridden: ${field}`, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE", { field, tool });
      }
      if (configured.value !== undefined) {
        parameters[field] = configured.value;
        sources[field] = "fixed";
      }
      if (configured.required && configured.value === undefined) {
        throw new HttpError(400, `Fixed Azure DevOps parameter is not configured: ${field}`, "AZURE_DEVOPS_FIXED_VALUE_MISSING", { field, tool });
      }
      continue;
    }

    if (configured.mode === "derived") {
      if (supplied) {
        throw new HttpError(400, `Derived Azure DevOps parameter cannot be supplied by an Agent: ${field}`, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT", { field, tool });
      }
      const derived = derivedValues[field];
      if (derived !== undefined) {
        const valueIssue = validateParameterValue(definition, derived);
        if (valueIssue) throw new HttpError(400, valueIssue.message, "AZURE_DEVOPS_DERIVED_PARAMETER_INVALID", { field, tool });
        parameters[field] = derived as AzureDevOpsJsonValue;
        sources[field] = "derived";
      } else if (configured.required) {
        throw new HttpError(400, `Derived Azure DevOps parameter is unavailable: ${field}`, "AZURE_DEVOPS_DERIVED_PARAMETER_MISSING", { field, tool });
      }
      continue;
    }

    if (supplied) {
      const valueIssue = validateParameterValue(definition, suppliedValue);
      if (valueIssue) throw new HttpError(400, valueIssue.message, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID", { field, tool });
      parameters[field] = suppliedValue as AzureDevOpsJsonValue;
      sources[field] = "agent";
    } else if (configured.required) {
      throw new HttpError(400, `Required Azure DevOps tool parameter is missing: ${field}`, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED", { field, tool });
    }
  }

  if (options.purpose !== "credential-broker"
    && (tool === "azure_devops_configure_remote" || tool === "azure_devops_clone_repository")) {
    const hasRepositoryIdentity = ["repositoryReference", "repositoryID", "repositoryName"].some((field) => parameters[field] !== undefined);
    if (!hasRepositoryIdentity) {
      throw new HttpError(400, "A verified repository reference, repository ID, or repository name is required", "AZURE_DEVOPS_REPOSITORY_REFERENCE_REQUIRED", { tool });
    }
  }
  if (tool === "azure_devops_create_pull_request") {
    const listValues = Object.fromEntries(PULL_REQUEST_LIST_FIELDS.flatMap((field) =>
      Object.prototype.hasOwnProperty.call(parameters, field) ? [[field, parameters[field]]] : [],
    ));
    if (JSON.stringify(listValues).length > PULL_REQUEST_LIST_SERIALIZED_MAX_LENGTH) {
      throw new HttpError(
        400,
        "Pull request reviewerIds, workItemIds, and labels exceed the combined 10,000 character limit",
        "AZURE_DEVOPS_AGENT_PARAMETER_INVALID",
        { field: PULL_REQUEST_LIST_FIELDS.join(", "), tool },
      );
    }
  }
  if (tool === "azure_devops_create_pull_request" || tool === "azure_devops_list_pull_requests") {
    const repositorySelectors = ["repositoryReference", "repositoryID", "repositoryName"]
      .filter((field) => parameters[field] !== undefined);
    if (repositorySelectors.length !== 1) {
      throw new HttpError(400, "Provide exactly one verified Repository reference, ID, or name", "AZURE_DEVOPS_REPOSITORY_IDENTITY_INVALID", { tool });
    }
    if (typeof parameters.repositoryReference === "string") {
      assertPullRequestRepositoryReferenceContext(parameters.repositoryReference, parameters.organization, parameters.project, tool);
    }
  }
  return { parameters, sources, tool };
}

function assertPullRequestRepositoryReferenceContext(value: string, organization: unknown, project: unknown, tool: AzureDevOpsToolName): void {
  const match = /^azure-devops:\/\/([^/]+)\/([^/]+)\/([0-9a-f-]{36})$/i.exec(value);
  if (!match || !UUID_PATTERN.test(match[3]!)) {
    throw new HttpError(400, "The Azure DevOps repository reference is invalid", "AZURE_DEVOPS_REPOSITORY_REFERENCE_INVALID", { tool });
  }
  let referenceOrganization: string;
  let referenceProject: string;
  try {
    referenceOrganization = decodeURIComponent(match[1]!);
    referenceProject = decodeURIComponent(match[2]!);
  } catch {
    throw new HttpError(400, "The Azure DevOps repository reference is invalid", "AZURE_DEVOPS_REPOSITORY_REFERENCE_INVALID", { tool });
  }
  if (typeof organization !== "string" || referenceOrganization.toLowerCase() !== organization.toLowerCase()) {
    throw new HttpError(409, "The repository reference belongs to another Azure DevOps organization", "AZURE_DEVOPS_ORGANIZATION_MISMATCH", { tool });
  }
  if (typeof project !== "string" || referenceProject.toLowerCase() !== project.toLowerCase()) {
    throw new HttpError(409, "The repository reference belongs to another Azure DevOps project", "AZURE_DEVOPS_PROJECT_MISMATCH", { tool });
  }
}

function fixed(parameterType: AzureDevOpsParameterDefinition["parameterType"], required = false, defaultValue?: AzureDevOpsJsonValue): AzureDevOpsParameterDefinition {
  return { defaultMode: "fixed", parameterType, ...(required ? { required: true } : {}), ...(defaultValue === undefined ? {} : { defaultValue }) };
}

function agent(parameterType: AzureDevOpsParameterDefinition["parameterType"], required = false): AzureDevOpsParameterDefinition {
  return { defaultMode: "agent", parameterType, ...(required ? { required: true } : {}) };
}

function array(
  arrayItemType: NonNullable<AzureDevOpsParameterDefinition["arrayItemType"]>,
  maxItems: number,
  constraints: Pick<AzureDevOpsParameterDefinition, "itemMaximum" | "itemMaximumLength" | "itemMinimum"> = {},
): AzureDevOpsParameterDefinition {
  return {
    ...agent("array"),
    allowedModes: ["agent", "fixed"],
    arrayItemType,
    maxItems,
    ...constraints,
  };
}

function derived(parameterType: AzureDevOpsParameterDefinition["parameterType"]): AzureDevOpsParameterDefinition {
  return { defaultMode: "derived", forcedMode: "derived", parameterType };
}

function validateParameterValue(definition: AzureDevOpsParameterDefinition, value: unknown): AzureDevOpsPolicyIssue | undefined {
  if (definition.parameterType === "array") return validateArrayParameterValue(definition, value);
  if (definition.parameterType === "boolean" && typeof value !== "boolean") return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Azure DevOps parameter must be a boolean." };
  if (definition.parameterType === "integer") {
    const minimum = definition.minimum ?? 1;
    const maximum = definition.maximum ?? definition.maxValue ?? 100_000;
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: `Azure DevOps integer parameter must be between ${minimum} and ${maximum}.` };
    }
  }
  if (definition.parameterType === "number") {
    const minimum = definition.minimum ?? 0;
    const maximum = definition.maximum;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (maximum !== undefined && value > maximum)) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Azure DevOps numeric parameter must be a finite, non-negative number." };
    }
  }
  if (definition.parameterType === "uuid" && (typeof value !== "string" || !UUID_PATTERN.test(value))) return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Azure DevOps ID parameter must be a UUID." };
  const maxLength = definition.maxLength ?? NON_EMPTY_STRING_MAX_LENGTH;
  if (definition.parameterType === "string"
    && (typeof value !== "string"
      || (!definition.allowEmpty && value.trim().length === 0)
      || value.length > maxLength)) {
    return {
      code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID",
      message: definition.allowEmpty
        ? `Azure DevOps string parameter must be at most ${maxLength} characters.`
        : `Azure DevOps string parameter must be non-empty and at most ${maxLength} characters.`,
    };
  }
  if (definition.parameterFormat === "project-repository-path" && !isProjectRepositoryPath(value, maxLength)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "repositoryPath must be repository/<name> inside the current project." };
  }
  if (definition.parameterFormat === "pipeline-yaml-path" && !isAzureDevOpsPipelineYamlPath(value, maxLength)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Pipeline YAML path must be a repository-relative .yml or .yaml path without traversal." };
  }
  if (definition.parameterFormat === "repository-yaml-path" && !isRepositoryYamlPath(value, maxLength)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "yamlPath must be a repository-relative .yml or .yaml path without parent traversal." };
  }
  if (definition.parameterFormat === "pipeline-folder" && !isPipelineFolder(value, maxLength)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "folder must be a bounded Azure DevOps Pipeline folder path without parent traversal." };
  }
  if (definition.parameterFormat === "azure-devops-branch-ref" && !isAzureDevOpsBranchRef(value)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "branchRef must be a valid refs/heads/<branch> Azure DevOps ref." };
  }
  if (definition.parameterFormat === "azure-devops-repository-reference" && !isAzureDevOpsRepositoryReference(value)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "repositoryReference must be a verified azure-devops:// organization/project/UUID reference." };
  }
  if (definition.parameterFormat === "azure-devops-repository-name" && !isAzureDevOpsRepositoryName(value)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "repositoryName must be a single Azure DevOps repository name without path separators or control characters." };
  }
  if (definition.parameterFormat === "azure-devops-pull-request-status" && !isAzureDevOpsPullRequestStatus(value)) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "status must be active, abandoned, completed, or all." };
  }
  if (definition.parameterType === "pipeline-template-parameters") {
    const issue = validatePipelineTemplateParameters(value);
    if (issue) return issue;
  }
  return undefined;
}

function validateArrayParameterValue(definition: AzureDevOpsParameterDefinition, value: unknown): AzureDevOpsPolicyIssue | undefined {
  const maxItems = definition.maxItems ?? 50;
  if (!Array.isArray(value) || value.length > maxItems || Object.keys(value).length !== value.length || !definition.arrayItemType) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: `Azure DevOps list parameter must be an array of at most ${maxItems} supported primitive values.` };
  }
  for (const item of value) {
    if (definition.arrayItemType === "uuid" && (typeof item !== "string" || !UUID_PATTERN.test(item))) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Pull request reviewerIds must contain UUIDs." };
    }
    if (definition.arrayItemType === "integer"
      && (typeof item !== "number" || !Number.isSafeInteger(item)
        || item < (definition.itemMinimum ?? 1) || item > (definition.itemMaximum ?? 2_147_483_647))) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "Pull request workItemIds must contain positive 32-bit integer IDs." };
    }
    if (definition.arrayItemType === "string"
      && (typeof item !== "string" || item.trim().length === 0 || item.length > (definition.itemMaximumLength ?? 128))) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: `Pull request labels must be non-empty strings of at most ${definition.itemMaximumLength ?? 128} characters.` };
    }
  }
  return undefined;
}

function isAzureDevOpsPipelineYamlPath(value: unknown, maxLength: number): value is string {
  return isRepositoryRelativeYamlPath(value, maxLength, true);
}

function isRepositoryRelativeYamlPath(value: unknown, maxLength: number, rejectDrivePrefix: boolean): value is string {
  if (typeof value !== "string"
    || value !== value.trim()
    || value.length > maxLength
    || !value
    || value.startsWith("/")
    || (rejectDrivePrefix && /^[A-Za-z]:/.test(value))
    || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return /\.ya?ml$/i.test(value);
}

function validatePipelineTemplateParameters(value: unknown): AzureDevOpsPolicyIssue | undefined {
  if (!isRecord(value)) return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters must be an object of bounded scalar values." };
  const entries = Object.entries(value);
  if (entries.length > 20) return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters cannot contain more than 20 entries." };
  for (const [name, parameterValue] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)
      || /(?:api[-_]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|credential|private[-_]?key|(?:^|[^a-z0-9])pat(?:$|[^a-z0-9]))/i.test(name)
      || ["__proto__", "prototype", "constructor"].includes(name)) {
      return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters contains an invalid or sensitive parameter name." };
    }
    if (typeof parameterValue === "string") {
      if (parameterValue.length > 1_000
        || /[\u0000-\u001f\u007f]/.test(parameterValue)
        || /(?:bearer\s+|pat[-_]|token[-_]|secret[-_]|password\s*[:=])/i.test(parameterValue)) {
        return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters contains a secret-shaped or oversized value." };
      }
      continue;
    }
    if (typeof parameterValue === "boolean") continue;
    if (typeof parameterValue === "number" && Number.isFinite(parameterValue)) continue;
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters values must be strings, finite numbers, or booleans." };
  }
  if (JSON.stringify(value).length > 10_000) {
    return { code: "AZURE_DEVOPS_PARAMETER_TYPE_INVALID", message: "templateParameters exceeds the 10,000 character limit." };
  }
  return undefined;
}

function isAzureDevOpsBranchRef(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || !value.startsWith("refs/heads/") || value.length > 255) return false;
  const branch = value.slice("refs/heads/".length);
  if (!branch || branch === "@" || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")
    || branch.includes("..") || branch.includes("//") || branch.includes("@{")
    || /[\u0000-\u0020\u007f~^:?*]/.test(branch) || branch.includes("\\") || branch.includes("[") || branch.includes("]")) return false;
  return branch.split("/").every((segment) => segment.length > 0
    && !segment.startsWith(".")
    && !segment.endsWith(".")
    && !segment.toLowerCase().endsWith(".lock"));
}

function isAzureDevOpsRepositoryReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^azure-devops:\/\/([^/]+)\/([^/]+)\/([0-9a-f-]{36})$/i.exec(value);
  if (!match || !UUID_PATTERN.test(match[3]!)) return false;
  try {
    return Boolean(decodeURIComponent(match[1]!) && decodeURIComponent(match[2]!));
  } catch {
    return false;
  }
}

function isAzureDevOpsRepositoryName(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function isAzureDevOpsPullRequestStatus(value: unknown): value is "active" | "abandoned" | "completed" | "all" {
  return value === "active" || value === "abandoned" || value === "completed" || value === "all";
}

function isProjectRepositoryPath(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value !== value.trim() || value.length > maxLength || value.includes("\\")) return false;
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== "repository") return false;
  const name = segments[1];
  if (!name || name === "." || name === ".." || name.toLowerCase() === ".git"
    || /[\u0000-\u001f\u007f<>:"|?*]/.test(name) || /[ .]$/.test(name)) return false;
  const stem = name.split(".", 1)[0]!.toUpperCase();
  return !["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)].includes(stem);
}

function isRepositoryYamlPath(value: unknown, maxLength: number): value is string {
  return isRepositoryRelativeYamlPath(value, maxLength, false);
}

function isPipelineFolder(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value !== value.trim() || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value === "\\") return true;
  const segments = value.replaceAll("/", "\\").split("\\").filter((segment, index) => !(index === 0 && segment === ""));
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && !value.includes("//") && !value.includes("\\\\");
}

function fixedProjectFromPolicy(policy: AzureDevOpsParameterPolicy, tool: AzureDevOpsToolName): string | undefined {
  const project = policy.tools?.[tool]?.fields?.project?.value;
  return typeof project === "string" ? project : undefined;
}

function containsSecretValue(value: unknown, key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) return typeof value === "string" && !ENVIRONMENT_REFERENCE_PATTERN.test(value);
  if (typeof value === "string") return /(?:bearer\s+|pat[-_]|token[-_]|secret[-_])/i.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretValue(item, key));
  if (isRecord(value)) return Object.entries(value).some(([childKey, childValue]) => containsSecretValue(childValue, childKey));
  return false;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAzureDevOpsJsonValue(value: unknown): value is AzureDevOpsJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAzureDevOpsJsonValue);
  return isRecord(value) && Object.values(value).every(isAzureDevOpsJsonValue);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
