export const AZURE_DEVOPS_TOOL_NAMES = [
  "azure_devops_create_repository",
  "azure_devops_configure_remote",
  "azure_devops_git_pull",
  "azure_devops_push",
  "azure_devops_clone_repository",
  "azure_devops_list_repositories",
  "azure_devops_list_pipelines",
  "azure_devops_create_pipeline",
  "azure_devops_create_pull_request",
  "azure_devops_get_pull_request",
  "azure_devops_list_pull_requests",
  "azure_devops_preview_pipeline",
  "azure_devops_run_pipeline",
  "azure_devops_get_pipeline_run",
  "azure_devops_list_wikis",
  "azure_devops_write_wiki_page",
  "azure_devops_create_work_item",
  "azure_devops_get_work_item",
  "azure_devops_list_work_item_revisions",
  "azure_devops_update_work_item",
  "azure_devops_publish_pipeline_yaml",
] as const;

export type AzureDevOpsToolName = (typeof AZURE_DEVOPS_TOOL_NAMES)[number];
export type AzureDevOpsPolicyMode = "fixed" | "agent" | "derived";
export type AzureDevOpsParameterSource = AzureDevOpsPolicyMode;
export type AzureDevOpsJsonValue =
  | string
  | number
  | boolean
  | null
  | AzureDevOpsJsonValue[]
  | { [key: string]: AzureDevOpsJsonValue };

export type AzureDevOpsParameterPolicyField = {
  mode: AzureDevOpsPolicyMode;
  required?: boolean;
  value?: AzureDevOpsJsonValue;
};

export type AzureDevOpsToolParameterPolicy = {
  fields: Record<string, AzureDevOpsParameterPolicyField>;
};

export type AzureDevOpsParameterPolicy = {
  version: 1;
  tools: Record<AzureDevOpsToolName, AzureDevOpsToolParameterPolicy>;
};

export type AzureDevOpsParameterType = "array" | "boolean" | "integer" | "number" | "pipeline-template-parameters" | "string" | "uuid";
export type AzureDevOpsArrayItemType = "integer" | "string" | "uuid";

export type AzureDevOpsParameterDefinition = {
  allowedModes?: readonly AzureDevOpsPolicyMode[];
  defaultMode: AzureDevOpsPolicyMode;
  defaultValue?: AzureDevOpsJsonValue;
  forcedMode?: AzureDevOpsPolicyMode;
  arrayItemType?: AzureDevOpsArrayItemType;
  itemMaximum?: number;
  itemMaximumLength?: number;
  itemMinimum?: number;
  maxItems?: number;
  maximum?: number;
  allowEmpty?: boolean;
  maxLength?: number;
  maxValue?: number;
  minimum?: number;
  parameterFormat?: "azure-devops-branch-ref" | "azure-devops-pull-request-status" | "azure-devops-repository-name" | "azure-devops-repository-reference" | "pipeline-folder" | "pipeline-yaml-path" | "project-repository-path" | "repository-yaml-path";
  parameterType: AzureDevOpsParameterType;
  required?: boolean;
  requiredAlways?: boolean;
};

export type AzureDevOpsPolicyIssue = {
  code: string;
  field?: string;
  message: string;
};

export type AzureDevOpsPolicyValidation = {
  issues: AzureDevOpsPolicyIssue[];
  policy?: AzureDevOpsParameterPolicy;
};

export type AzureDevOpsResolvedToolCall = {
  parameters: Record<string, AzureDevOpsJsonValue>;
  sources: Record<string, AzureDevOpsParameterSource>;
  tool: AzureDevOpsToolName;
};

export type AzureDevOpsEffectiveContext = {
  adoProject?: string;
  context: Record<string, AzureDevOpsJsonValue>;
  openCodeProject: string;
  organization?: string;
  parameterPolicy: AzureDevOpsParameterPolicy;
  version: 1;
};
