import assert from "node:assert/strict";
import test from "node:test";
import {
  AZURE_DEVOPS_TOOL_NAMES,
  assertAzureDevOpsParameterPolicy,
  assertAzureDevOpsProjectContext,
  completeAzureDevOpsParameterPolicy,
  createDefaultAzureDevOpsParameterPolicy,
  mergeAzureDevOpsContext,
  resolveAzureDevOpsEffectiveContext,
  resolveAzureDevOpsToolCall,
  withAzureDevOpsRuntimeContext,
} from "../policy/index.ts";
import { ExtensionBackendService } from "../src/features/extensions/backend.js";
const policyHookExport = `export { prepareRequest } from ${JSON.stringify(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url).href)};`;

test("publishes a field-level policy for every Azure DevOps Plugin tool", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  assert.deepEqual([...AZURE_DEVOPS_TOOL_NAMES], [
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
  ]);
  assert.equal(policy.version, 1);
  assert.equal(policy.tools.azure_devops_create_repository.fields.project?.mode, "fixed");
  assert.equal(policy.tools.azure_devops_create_repository.fields.project?.value, "ado-project");
  assert.equal(policy.tools.azure_devops_create_repository.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_configure_remote.fields.remoteUrl?.mode, "derived");
  assert.equal(policy.tools.azure_devops_configure_remote.fields.repositoryPath?.mode, "agent");
  assert.equal(policy.tools.azure_devops_configure_remote.fields.repositoryPath?.required, undefined);
  assert.equal(policy.tools.azure_devops_git_pull.fields.branch?.mode, "agent");
  assert.equal(policy.tools.azure_devops_git_pull.fields.repositoryPath?.required, true);
  assert.equal(policy.tools.azure_devops_push.fields.credential?.mode, "derived");
  assert.equal(policy.tools.azure_devops_push.fields.repositoryPath?.mode, "agent");
  assert.equal(policy.tools.azure_devops_push.fields.repositoryPath?.required, true);
  assert.equal(policy.tools.azure_devops_clone_repository.fields.destination?.mode, "agent");
  assert.equal(policy.tools.azure_devops_list_repositories.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_list_repositories.fields.project?.mode, "fixed");
  assert.equal(policy.tools.azure_devops_list_repositories.fields.project?.value, "ado-project");
  assert.equal(policy.tools.azure_devops_list_repositories.fields.project?.required, true);
  assert.equal(policy.tools.azure_devops_list_wikis.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_list_wikis.fields.project?.value, "ado-project");
  assert.equal(policy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier?.mode, "derived");
  assert.equal(policy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier?.required, true);
  assert.equal(policy.tools.azure_devops_write_wiki_page.fields.path?.required, true);
  assert.equal(policy.tools.azure_devops_write_wiki_page.fields.content?.required, true);
  assert.equal(policy.tools.azure_devops_create_work_item.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_create_work_item.fields.project?.mode, "fixed");
  assert.equal(policy.tools.azure_devops_create_work_item.fields.workItemType?.required, true);
  assert.equal(policy.tools.azure_devops_create_work_item.fields.title?.required, true);
  assert.equal(policy.tools.azure_devops_create_work_item.fields.description?.required, undefined);
  assert.equal(policy.tools.azure_devops_create_work_item.fields.parentId?.mode, "agent");
  assert.equal(policy.tools.azure_devops_create_work_item.fields.parentId?.required, undefined);
  assert.equal(policy.tools.azure_devops_get_work_item.fields.organization?.mode, "derived");
  assert.deepEqual(policy.tools.azure_devops_get_work_item.fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(policy.tools.azure_devops_get_work_item.fields.workItemId, { mode: "agent", required: true });
  assert.equal(policy.tools.azure_devops_update_work_item.fields.organization?.mode, "derived");
  assert.deepEqual(policy.tools.azure_devops_update_work_item.fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.equal(policy.tools.azure_devops_update_work_item.fields.workItemId?.mode, "agent");
  assert.equal(policy.tools.azure_devops_update_work_item.fields.workItemId?.required, true);
  assert.deepEqual(policy.tools.azure_devops_update_work_item.fields.expectedRev, { mode: "agent" });
  assert.equal(policy.tools.azure_devops_update_work_item.fields.workItemType?.required, undefined);
  assert.equal(policy.tools.azure_devops_update_work_item.fields.title?.required, undefined);
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.organization?.mode, "derived");
  assert.deepEqual(policy.tools.azure_devops_create_pull_request.fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.repositoryReference?.mode, "agent");
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.repositoryID?.mode, "agent");
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.repositoryName?.mode, "agent");
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.sourceRefName?.required, true);
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.targetRefName?.required, true);
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.title?.required, true);
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.description?.required, undefined);
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.isDraft?.mode, "agent");
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.supportsIterations?.mode, "agent");
  assert.deepEqual(policy.tools.azure_devops_list_pull_requests.fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.equal(policy.tools.azure_devops_list_pull_requests.fields.organization?.mode, "derived");
  for (const field of ["repositoryReference", "repositoryID", "repositoryName", "sourceRefName", "targetRefName", "status", "top", "skip"] as const) {
    assert.equal(policy.tools.azure_devops_list_pull_requests.fields[field]?.mode, "agent");
  }
  assert.equal(policy.tools.azure_devops_list_pull_requests.fields.top?.required, undefined);
  assert.equal(policy.tools.azure_devops_list_pull_requests.fields.skip?.required, undefined);
  for (const field of ["reviewerIds", "workItemIds", "labels"] as const) {
    assert.equal(policy.tools.azure_devops_create_pull_request.fields[field]?.mode, "agent");
    assert.equal(policy.tools.azure_devops_create_pull_request.fields[field]?.required, undefined);
  }
  for (const field of ["areaPath", "iterationPath", "assignedTo", "priority", "tags", "state", "reproSteps", "systemInfo", "severity", "acceptanceCriteria"] as const) {
    assert.equal(policy.tools.azure_devops_create_work_item.fields[field]?.mode, "agent");
    assert.equal(policy.tools.azure_devops_create_work_item.fields[field]?.required, undefined);
  }
  for (const field of [
    "originalEstimate",
    "remainingWork",
    "completedWork",
    "activity",
    "storyPoints",
    "effort",
    "size",
    "businessValue",
  ]) {
    assert.equal(policy.tools.azure_devops_create_work_item.fields[field]?.mode, "agent");
  }
  const publishYaml = policy.tools.azure_devops_publish_pipeline_yaml.fields;
  assert.deepEqual(publishYaml.organization, { mode: "derived" });
  assert.deepEqual(publishYaml.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.equal(publishYaml.repositoryID?.mode, "agent");
  assert.equal(publishYaml.repositoryName?.mode, "agent");
  assert.equal(publishYaml.path?.mode, "agent");
  assert.equal(publishYaml.path?.required, true);
  assert.equal(publishYaml.yamlContent?.mode, "agent");
  assert.equal(publishYaml.yamlContent?.required, true);
  for (const tool of ["azure_devops_preview_pipeline", "azure_devops_run_pipeline"] as const) {
    assert.equal(policy.tools[tool].fields.project?.mode, "fixed");
    assert.equal(policy.tools[tool].fields.pipelineId?.mode, "agent");
    assert.equal(policy.tools[tool].fields.pipelineId?.required, true);
    assert.equal(policy.tools[tool].fields.branchRef?.mode, "agent");
    assert.equal(policy.tools[tool].fields.templateParameters?.mode, "agent");
  }
  assert.equal(policy.tools.azure_devops_get_pipeline_run.fields.pipelineId?.required, true);
  assert.equal(policy.tools.azure_devops_get_pipeline_run.fields.runId?.required, true);
  assert.deepEqual(policy.tools.azure_devops_get_pull_request.fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.equal(policy.tools.azure_devops_get_pull_request.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_get_pull_request.fields.pullRequestId?.mode, "agent");
  assert.equal(policy.tools.azure_devops_get_pull_request.fields.pullRequestId?.required, true);
  assert.equal(policy.tools.azure_devops_get_pull_request.fields.commitTop?.mode, "agent");
  assert.equal(policy.tools.azure_devops_get_pull_request.fields.commitContinuationToken?.mode, "agent");

  policy.tools.azure_devops_write_wiki_page.fields.content = { mode: "agent", required: false };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(policy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("Pipeline YAML policy pins Project context and requires bounded YAML content from each Agent call", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const yamlContent = "trigger:\n  - main\n";
  const repositoryID = "11111111-1111-4111-8111-111111111111";
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_publish_pipeline_yaml",
    policy,
    { repositoryID, path: "pipelines/release.yml", yamlContent },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryID,
    path: "pipelines/release.yml",
    yamlContent,
  });
  assert.deepEqual(resolved.sources, {
    organization: "derived",
    project: "fixed",
    repositoryID: "agent",
    path: "agent",
    yamlContent: "agent",
  });

  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  fixedPolicy.tools.azure_devops_publish_pipeline_yaml.fields.repositoryName = { mode: "fixed", value: "pipeline-repository" };
  fixedPolicy.tools.azure_devops_publish_pipeline_yaml.fields.path = { mode: "fixed", value: "pipelines/fixed.yml" };
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));

  const fixedContentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  fixedContentPolicy.tools.azure_devops_publish_pipeline_yaml.fields.yamlContent = { mode: "fixed", value: yamlContent };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(fixedContentPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );

  assert.deepEqual(resolveAzureDevOpsToolCall(
    "azure_devops_publish_pipeline_yaml",
    fixedPolicy,
    { yamlContent },
    { organization: "contoso" },
  ).parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryName: "pipeline-repository",
    path: "pipelines/fixed.yml",
    yamlContent,
  });
  assert.equal(resolveAzureDevOpsToolCall(
    "azure_devops_publish_pipeline_yaml",
    fixedPolicy,
    { yamlContent },
    { organization: "contoso" },
  ).sources.yamlContent, "agent");
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_publish_pipeline_yaml",
      fixedPolicy,
      {},
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );

  for (const path of ["../release.yml", "/release.yml", "C:/release.yaml", "pipelines//release.yml", "release.txt"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_publish_pipeline_yaml",
        policy,
        { repositoryID, path, yamlContent },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_publish_pipeline_yaml",
      policy,
      { repositoryID, path: "pipelines/release.yml", yamlContent: "x".repeat(100_001) },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_publish_pipeline_yaml",
      policy,
      { project: "another-project", repositoryID, path: "pipelines/release.yml", yamlContent },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_publish_pipeline_yaml",
      policy,
      { organization: "another-org", repositoryID, path: "pipelines/release.yml", yamlContent },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
});

test("Pipeline preview and run policies bound IDs, branch refs, and scalar template parameters", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  assert.deepEqual(policy.tools.azure_devops_preview_pipeline, policy.tools.azure_devops_run_pipeline);
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_run_pipeline",
    policy,
    {
      pipelineId: 42,
      branchRef: "refs/heads/release/2026",
      templateParameters: { environment: "staging", deploy: true, replicas: 3 },
    },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    pipelineId: 42,
    branchRef: "refs/heads/release/2026",
    templateParameters: { environment: "staging", deploy: true, replicas: 3 },
  });
  assert.deepEqual(resolved.sources, {
    organization: "derived",
    project: "fixed",
    pipelineId: "agent",
    branchRef: "agent",
    templateParameters: "agent",
  });

  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_preview_pipeline", policy, { pipelineId: 0 }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_run_pipeline", policy, { pipelineId: 42, branchRef: "refs/heads/../main" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  for (const templateParameters of [
    { accessToken: "forbidden" },
    { nested: { value: "forbidden" } },
    { password: "never-store" },
    { "invalid name": "forbidden" },
    { environment: "password=inline-secret" },
    { environment: "x".repeat(1_001) },
    Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`parameter${index}`, index])),
    Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`parameter${index}`, "x".repeat(1_000)])),
  ]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall("azure_devops_run_pipeline", policy, { pipelineId: 42, templateParameters }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
});

test("BFF maps Pipeline preview, run, and status paths to their project-scoped tool policies", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export async function activate() {
          return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
        }`),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "d".repeat(64),
        version: "1.6.36",
      }),
      readSettings: async () => ({ azureDevOps: { organization: "contoso", project: "ado-project", parameterPolicy: policy } }),
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };
  const cases = [
    { path: "preview-pipeline", tool: "azure_devops_preview_pipeline", agentInput: { pipelineId: 42, branchRef: "refs/heads/main" } },
    { path: "run-pipeline", tool: "azure_devops_run_pipeline", agentInput: { pipelineId: 42, templateParameters: { environment: "staging" } } },
    { path: "get-pipeline-run", tool: "azure_devops_get_pipeline_run", agentInput: { pipelineId: 42, runId: 74 } },
    { path: "create-pull-request", tool: "azure_devops_create_pull_request", agentInput: { repositoryName: "api", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", title: "PR title" } },
    { path: "get-pull-request", tool: "azure_devops_get_pull_request", agentInput: { pullRequestId: 910, commitTop: 25, commitContinuationToken: "next-page" } },
    { path: "list-pull-requests", tool: "azure_devops_list_pull_requests", agentInput: { repositoryName: "api", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" } },
  ] as const;

  for (const item of cases) {
    const result = await service.handle({
      body: { tool: item.tool, agentInput: item.agentInput },
      headers: {},
      method: "POST",
      params: { "*": item.path, extensionId: "azure-devops-platform" },
      query: { project: "managed-project", scope: "project" },
    } as never, reply as never) as { parameters: Record<string, unknown>; tool: string };
    assert.equal(result.tool, item.tool);
    assert.equal(result.parameters.organization, "contoso");
    assert.equal(result.parameters.project, "ado-project");
  }
});

test("pull request details policy requires a bounded ID and scopes pagination to the fixed Project", () => {
  const tool = "azure_devops_get_pull_request";
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const resolved = resolveAzureDevOpsToolCall(tool, policy, {
    pullRequestId: 910,
    commitTop: 25,
    commitContinuationToken: "next-page+/=",
  }, { organization: "contoso" });

  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    pullRequestId: 910,
    commitTop: 25,
    commitContinuationToken: "next-page+/=",
  });
  assert.equal(resolved.sources.organization, "derived");
  assert.equal(resolved.sources.project, "fixed");
  assert.equal(resolved.sources.pullRequestId, "agent");

  for (const invalid of [0, -1, 1.5, 2_147_483_648]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(tool, policy, { pullRequestId: invalid }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );
  for (const invalidTop of [0, 101, 1.5]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(tool, policy, { pullRequestId: 910, commitTop: invalidTop }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { pullRequestId: 910, commitContinuationToken: "x".repeat(2_001) }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );

  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  fixedPolicy.tools[tool].fields.pullRequestId = { mode: "fixed", value: 910 };
  fixedPolicy.tools[tool].fields.commitTop = { mode: "fixed", value: 100 };
  const fixedResolved = resolveAzureDevOpsToolCall(tool, fixedPolicy, {}, { organization: "contoso" });
  assert.equal(fixedResolved.parameters.pullRequestId, 910);
  assert.equal(fixedResolved.parameters.commitTop, 100);
  assert.equal(fixedResolved.sources.pullRequestId, "fixed");
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, fixedPolicy, { pullRequestId: 911 }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { pullRequestId: 910, project: "another-project" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("pull request policy resolves scalar fields from fixed or Agent sources and scopes repository identity", () => {
  const tool = "azure_devops_create_pull_request";
  const repositoryID = "11111111-1111-4111-8111-111111111111";
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentResolved = resolveAzureDevOpsToolCall(
    tool,
    policy,
    {
      repositoryReference: `azure-devops://contoso/ado-project/${repositoryID}`,
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Create the pull request",
      description: "Optional details",
      isDraft: true,
      supportsIterations: false,
    },
    { organization: "contoso" },
  );
  assert.deepEqual(agentResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryReference: `azure-devops://contoso/ado-project/${repositoryID}`,
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Create the pull request",
    description: "Optional details",
    isDraft: true,
    supportsIterations: false,
  });
  assert.equal(agentResolved.sources.project, "fixed");
  assert.equal(agentResolved.sources.organization, "derived");
  assert.equal(agentResolved.sources.title, "agent");

  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Missing repository selector",
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_REPOSITORY_IDENTITY_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {
      repositoryID,
      repositoryName: "api",
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Ambiguous repository selector",
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_REPOSITORY_IDENTITY_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {
      repositoryReference: `azure-devops://contoso/another-project/${repositoryID}`,
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Cross-project reference",
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PROJECT_MISMATCH"),
  );
  for (const sourceRefName of ["main", "refs/heads/../main", "refs/heads/feature//change", `refs/heads/${"x".repeat(245)}`]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(tool, policy, {
        repositoryID,
        sourceRefName,
        targetRefName: "refs/heads/main",
        title: "Reject malformed branch ref",
      }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {
      repositoryID,
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Unknown fields are rejected",
      unrecognizedParameter: true,
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_UNKNOWN"),
  );

  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  Object.assign(fixedPolicy.tools[tool].fields, {
    repositoryName: { mode: "fixed", value: "api" },
    sourceRefName: { mode: "fixed", value: "refs/heads/fixed-source" },
    title: { mode: "fixed", value: "Fixed pull request title" },
    isDraft: { mode: "fixed", value: false },
  });
  const fixedResolved = resolveAzureDevOpsToolCall(tool, fixedPolicy, {
    targetRefName: "refs/heads/main",
  }, { organization: "contoso" });
  assert.equal(fixedResolved.parameters.repositoryName, "api");
  assert.equal(fixedResolved.sources.repositoryName, "fixed");
  assert.equal(fixedResolved.parameters.sourceRefName, "refs/heads/fixed-source");
  assert.equal(fixedResolved.parameters.isDraft, false);
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, fixedPolicy, {
      repositoryName: "another-repository",
      targetRefName: "refs/heads/main",
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, fixedPolicy, {
      project: "another-project",
      targetRefName: "refs/heads/main",
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );

  const invalidFixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  invalidFixedPolicy.tools[tool].fields.sourceRefName = { mode: "fixed", value: "refs/heads/../main" };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(invalidFixedPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("pull request list policy scopes verified Repository selectors and bounds filters and paging", () => {
  const tool = "azure_devops_list_pull_requests";
  const repositoryID = "11111111-1111-4111-8111-111111111111";
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentInput = {
    repositoryName: "api",
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    status: "all",
    top: 100,
    skip: 2_147_483_647,
  };
  const resolved = resolveAzureDevOpsToolCall(tool, policy, agentInput, { organization: "contoso" });
  assert.deepEqual(resolved.parameters, { organization: "contoso", project: "ado-project", ...agentInput });
  assert.equal(resolved.sources.project, "fixed");
  assert.equal(resolved.sources.organization, "derived");
  assert.equal(resolved.sources.status, "agent");
  const referenceResolved = resolveAzureDevOpsToolCall(tool, policy, {
    repositoryReference: `azure-devops://contoso/ado-project/${repositoryID}`,
  }, { organization: "contoso" });
  assert.equal(referenceResolved.parameters.repositoryReference, `azure-devops://contoso/ado-project/${repositoryID}`);

  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_REPOSITORY_IDENTITY_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { repositoryID, repositoryName: "api" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_REPOSITORY_IDENTITY_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, {
      repositoryReference: `azure-devops://contoso/another-project/${repositoryID}`,
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PROJECT_MISMATCH"),
  );
  for (const invalidInput of [
    { repositoryID, sourceRefName: "feature/change" },
    { repositoryID, status: "not-a-status" },
    { repositoryID, top: 0 },
    { repositoryID, top: 101 },
    { repositoryID, skip: -1 },
    { repositoryID, skip: 2_147_483_648 },
  ]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(tool, policy, invalidInput, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { repositoryID, project: "other-project" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );

  policy.tools[tool].fields.repositoryName = { mode: "fixed", value: "api" };
  const fixedResolved = resolveAzureDevOpsToolCall(tool, policy, { repositoryName: "api", status: "active" }, { organization: "contoso" });
  assert.equal(fixedResolved.sources.repositoryName, "fixed");
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { repositoryName: "other" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("pull request description is optional and accepts any string up to its length limit", () => {
  const tool = "azure_devops_create_pull_request";
  const requiredInputs = {
    repositoryID: "11111111-1111-4111-8111-111111111111",
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Description contract",
  };
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  for (const description of ["", "   "]) {
    const resolved = resolveAzureDevOpsToolCall(tool, policy, { ...requiredInputs, description }, { organization: "contoso" });
    assert.equal(resolved.parameters.description, description);
    assert.equal(resolved.sources.description, "agent");
  }
  assert.equal(
    resolveAzureDevOpsToolCall(tool, policy, { ...requiredInputs, description: "x".repeat(100_000) }, { organization: "contoso" }).parameters.description,
    "x".repeat(100_000),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { ...requiredInputs, description: "x".repeat(100_001) }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );

  policy.tools[tool].fields.description = { mode: "fixed", value: "" };
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));
  const fixedResolved = resolveAzureDevOpsToolCall(tool, policy, requiredInputs, { organization: "contoso" });
  assert.equal(fixedResolved.parameters.description, "");
  assert.equal(fixedResolved.sources.description, "fixed");
});

test("pull request list fields support bounded primitive arrays from Agent and fixed policy sources", () => {
  const tool = "azure_devops_create_pull_request";
  const reviewerIds = ["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  const workItemIds = [74, 2_147_483_647];
  const labels = ["feature", "customer request"];
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const resolved = resolveAzureDevOpsToolCall(tool, policy, {
    repositoryID: "22222222-2222-4222-8222-222222222222",
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Create the pull request",
    reviewerIds,
    workItemIds,
    labels,
  }, { organization: "contoso" });

  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryID: "22222222-2222-4222-8222-222222222222",
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Create the pull request",
    reviewerIds,
    workItemIds,
    labels,
  });
  assert.equal(resolved.sources.reviewerIds, "agent");
  assert.equal(resolved.sources.workItemIds, "agent");
  assert.equal(resolved.sources.labels, "agent");

  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  Object.assign(fixedPolicy.tools[tool].fields, {
    repositoryName: { mode: "fixed", value: "api" },
    reviewerIds: { mode: "fixed", value: [reviewerIds[0]] },
    workItemIds: { mode: "fixed", value: [74] },
    labels: { mode: "fixed", value: ["release"] },
  });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));
  const fixedResolved = resolveAzureDevOpsToolCall(tool, fixedPolicy, {
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Create the fixed-list pull request",
  }, { organization: "contoso" });
  assert.deepEqual({
    reviewerIds: fixedResolved.parameters.reviewerIds,
    workItemIds: fixedResolved.parameters.workItemIds,
    labels: fixedResolved.parameters.labels,
  }, {
    reviewerIds: [reviewerIds[0]],
    workItemIds: [74],
    labels: ["release"],
  });
  for (const field of ["reviewerIds", "workItemIds", "labels"] as const) {
    assert.equal(fixedResolved.sources[field], "fixed");
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, fixedPolicy, {
      sourceRefName: "refs/heads/feature/change",
      targetRefName: "refs/heads/main",
      title: "Cannot override the fixed list",
      labels: ["agent value"],
    }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("pull request policy rejects malformed, nested, oversized, and unknown list values", () => {
  const tool = "azure_devops_create_pull_request";
  const repositoryID = "11111111-1111-4111-8111-111111111111";
  const requiredInputs = {
    repositoryID,
    sourceRefName: "refs/heads/feature/change",
    targetRefName: "refs/heads/main",
    title: "Reject malformed list values",
  };
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const invalidCases: Array<{ field: string; value: unknown }> = [
    { field: "reviewerIds", value: ["not-a-uuid"] },
    { field: "reviewerIds", value: [null] },
    { field: "reviewerIds", value: ["11111111-1111-4111-8111-111111111111", { id: "nested" }] },
    { field: "reviewerIds", value: Array(51).fill("11111111-1111-4111-8111-111111111111") },
    { field: "workItemIds", value: [0] },
    { field: "workItemIds", value: [2_147_483_648] },
    { field: "workItemIds", value: [1.5] },
    { field: "workItemIds", value: [[74]] },
    { field: "workItemIds", value: Array(51).fill(74) },
    { field: "labels", value: [""] },
    { field: "labels", value: ["  "] },
    { field: "labels", value: ["x".repeat(129)] },
    { field: "labels", value: [{ name: "nested" }] },
    { field: "labels", value: Array(51).fill("label") },
  ];
  for (const { field, value } of invalidCases) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(tool, policy, { ...requiredInputs, [field]: value }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
      `${field} should reject ${JSON.stringify(value).slice(0, 100)}`,
    );
  }

  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, policy, { ...requiredInputs, unexpected: "value" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_UNKNOWN"),
  );

  const oversized = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const escapedLabels = Array(50).fill('"'.repeat(128));
  assert.throws(
    () => resolveAzureDevOpsToolCall(tool, oversized, { ...requiredInputs, labels: escapedLabels }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  oversized.tools[tool].fields.labels = { mode: "fixed", value: escapedLabels };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(oversized, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );

  const invalidFixed = createDefaultAzureDevOpsParameterPolicy("ado-project");
  invalidFixed.tools[tool].fields.workItemIds = { mode: "fixed", value: [0] };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(invalidFixed, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("Work Item type and title are required after either Agent or fixed policy resolution", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const markdown = "# Background\n\n- first item\n- second item\n";

  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_create_work_item", policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );

  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_work_item",
    policy,
    { workItemType: "User Story", title: "Add the create flow", description: markdown, parentId: 123 },
    { organization: "contoso" },
  );
  assert.deepEqual(agentResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemType: "User Story",
    title: "Add the create flow",
    description: markdown,
    parentId: 123,
  });
  assert.deepEqual(agentResolved.sources, {
    organization: "derived",
    project: "fixed",
    workItemType: "agent",
    title: "agent",
    description: "agent",
    parentId: "agent",
  });

  for (const parentId of [0, -1, 1.5, 2_147_483_648]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        createDefaultAzureDevOpsParameterPolicy("ado-project"),
        { workItemType: "Task", title: "Validate parent ID", parentId },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  policy.tools.azure_devops_create_work_item.fields.workItemType = { mode: "fixed", required: true, value: "Task" };
  policy.tools.azure_devops_create_work_item.fields.title = { mode: "fixed", required: true, value: "Review deployment" };
  policy.tools.azure_devops_create_work_item.fields.description = { mode: "fixed", value: markdown };
  policy.tools.azure_devops_create_work_item.fields.parentId = { mode: "fixed", value: 456 };
  const fixedResolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_work_item",
    policy,
    {},
    { organization: "contoso" },
  );
  assert.deepEqual(fixedResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemType: "Task",
    title: "Review deployment",
    description: markdown,
    parentId: 456,
  });
  assert.equal(fixedResolved.sources.workItemType, "fixed");
  assert.equal(fixedResolved.sources.title, "fixed");
  assert.equal(fixedResolved.sources.description, "fixed");
  assert.equal(fixedResolved.sources.parentId, "fixed");

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      policy,
      { title: "Override fixed title", parentId: 789 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      policy,
      { parentId: 789 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  for (const relationParameter of ["relationType", "relationUrl"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        policy,
        { parentId: 73, [relationParameter]: "arbitrary" },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_UNKNOWN"),
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      policy,
      { organization: "other-org" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      policy,
      { project: "other-project" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );

  policy.tools.azure_devops_create_work_item.fields.project = { mode: "agent", required: true };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(policy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("Work Item reads require a bounded Agent or fixed ID and keep the Project context fixed", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_get_work_item",
    policy,
    { workItemId: 74 },
    { organization: "contoso" },
  );
  assert.deepEqual(agentResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemId: 74,
  });
  assert.deepEqual(agentResolved.sources, {
    organization: "derived",
    project: "fixed",
    workItemId: "agent",
  });

  for (const workItemId of [0, -1, 1.5, 2_147_483_648, "74"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_get_work_item",
        createDefaultAzureDevOpsParameterPolicy("ado-project"),
        { workItemId },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  policy.tools.azure_devops_get_work_item.fields.workItemId = { mode: "fixed", required: true, value: 918 };
  const fixedResolved = resolveAzureDevOpsToolCall(
    "azure_devops_get_work_item",
    policy,
    {},
    { organization: "contoso" },
  );
  assert.equal(fixedResolved.parameters.workItemId, 918);
  assert.equal(fixedResolved.sources.workItemId, "fixed");
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_get_work_item",
      policy,
      { workItemId: 919 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_get_work_item",
      policy,
      { project: "other-project" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("Work Item revision history policy bounds paging and preserves the fixed project context", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_list_work_item_revisions",
    policy,
    { workItemId: 74, top: 20, skip: 0 },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemId: 74,
    top: 20,
    skip: 0,
  });
  assert.deepEqual(resolved.sources, {
    organization: "derived",
    project: "fixed",
    workItemId: "agent",
    top: "agent",
    skip: "agent",
  });
  const maximumSkip = resolveAzureDevOpsToolCall(
    "azure_devops_list_work_item_revisions",
    policy,
    { workItemId: 74, skip: 2_147_483_647 },
    { organization: "contoso" },
  );
  assert.equal(maximumSkip.parameters.skip, 2_147_483_647);

  for (const input of [
    { workItemId: 0 },
    { workItemId: 74, top: 0 },
    { workItemId: 74, top: 21 },
    { workItemId: 74, skip: -1 },
    { workItemId: 74, skip: 2_147_483_648 },
  ]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall("azure_devops_list_work_item_revisions", policy, input, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  policy.tools.azure_devops_list_work_item_revisions.fields.top = { mode: "fixed", value: 10 };
  policy.tools.azure_devops_list_work_item_revisions.fields.skip = { mode: "fixed", value: 5 };
  const fixedPaging = resolveAzureDevOpsToolCall(
    "azure_devops_list_work_item_revisions",
    policy,
    { workItemId: 74 },
    { organization: "contoso" },
  );
  assert.equal(fixedPaging.parameters.top, 10);
  assert.equal(fixedPaging.parameters.skip, 5);
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_list_work_item_revisions",
      policy,
      { workItemId: 74, top: 20 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_list_work_item_revisions",
      policy,
      { workItemId: 74, project: "other-project" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("Work Item update requires an existing ID and resolves only fields selected for partial update", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_update_work_item", policy, { state: "Active" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );

  for (const workItemId of [0, -1, 1.5, 2_147_483_648, "74"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall("azure_devops_update_work_item", policy, { workItemId, state: "Active" }, { organization: "contoso" }),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  const legacyResolved = resolveAzureDevOpsToolCall(
    "azure_devops_update_work_item",
    policy,
    { workItemId: 74, state: "Active" },
    { organization: "contoso" },
  );
  assert.equal(legacyResolved.parameters.expectedRev, undefined);
  assert.equal(legacyResolved.sources.expectedRev, undefined);

  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_update_work_item",
    policy,
    { workItemId: 74, expectedRev: 8, workItemType: "Task", state: "Active" },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemId: 74,
    expectedRev: 8,
    workItemType: "Task",
    state: "Active",
  });
  assert.equal(resolved.parameters.title, undefined);
  assert.equal(resolved.sources.workItemId, "agent");
  assert.equal(resolved.sources.expectedRev, "agent");
  assert.equal(resolved.sources.state, "agent");

  for (const expectedRev of [0, -1, 1.5, 2_147_483_648, "8"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_update_work_item",
        policy,
        { workItemId: 74, expectedRev, state: "Active" },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  policy.tools.azure_devops_update_work_item.fields.expectedRev = { mode: "fixed", value: 8 };
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_update_work_item",
      policy,
      { workItemId: 74, state: "Active" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );

  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  fixedPolicy.tools.azure_devops_update_work_item.fields.workItemId = { mode: "fixed", required: true, value: 74 };
  fixedPolicy.tools.azure_devops_update_work_item.fields.state = { mode: "fixed", value: "Active" };
  const fixedResolved = resolveAzureDevOpsToolCall("azure_devops_update_work_item", fixedPolicy, {}, { organization: "contoso" });
  assert.deepEqual(fixedResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemId: 74,
    state: "Active",
  });
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_update_work_item", fixedPolicy, { workItemId: 75 }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("Work Item classification fields independently support Agent and fixed policy", () => {
  const values: Record<string, string | number> = {
    areaPath: "Contoso\\Platform",
    iterationPath: "Contoso\\Sprint 1",
    assignedTo: "developer@example.com",
    priority: 2,
    tags: "agent-system; backend",
    state: "Active",
  };
  const baseInput = { workItemType: "Task", title: "Classified task" };
  const agentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_work_item",
    agentPolicy,
    { ...baseInput, ...values },
    { organization: "contoso" },
  );
  const omittedOptionalFields = resolveAzureDevOpsToolCall(
    "azure_devops_create_work_item",
    agentPolicy,
    baseInput,
    { organization: "contoso" },
  );
  for (const [field, value] of Object.entries(values)) {
    assert.equal(agentPolicy.tools.azure_devops_create_work_item.fields[field]?.mode, "agent");
    assert.equal(omittedOptionalFields.parameters[field], undefined);
    assert.equal(agentResolved.parameters[field], value);
    assert.equal(agentResolved.sources[field], "agent");

    const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    fixedPolicy.tools.azure_devops_create_work_item.fields[field] = { mode: "fixed", value };
    const fixedResolved = resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      fixedPolicy,
      baseInput,
      { organization: "contoso" },
    );
    assert.equal(fixedResolved.parameters[field], value);
    assert.equal(fixedResolved.sources[field], "fixed");

    const override = typeof value === "number" ? value + 1 : `${value} override`;
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        fixedPolicy,
        { ...baseInput, [field]: override },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
      `${field} fixed policy must reject Agent overrides`,
    );
  }
});

test("Bug and acceptance Work Item fields independently resolve from Agent or fixed policy", () => {
  const values = {
    reproSteps: "# Reproduction\n\n1. Open the page\n2. Submit the form\n",
    systemInfo: "## Environment\n\n- OS: Linux\n- Runtime: Node.js\n",
    severity: "2 - High",
    acceptanceCriteria: "- [ ] The form validates input\n- [ ] Errors remain actionable\n",
  };
  const fields = Object.keys(values) as Array<keyof typeof values>;

  for (const field of fields) {
    const agentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    const agentResolved = resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      agentPolicy,
      { workItemType: "Bug", title: "Capture type-specific details", [field]: values[field] },
      { organization: "contoso" },
    );
    assert.equal(agentResolved.parameters[field], values[field]);
    assert.equal(agentResolved.sources[field], "agent");

    const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    fixedPolicy.tools.azure_devops_create_work_item.fields[field] = { mode: "fixed", value: values[field] };
    const fixedResolved = resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      fixedPolicy,
      { workItemType: "Bug", title: "Capture type-specific details" },
      { organization: "contoso" },
    );
    assert.equal(fixedResolved.parameters[field], values[field]);
    assert.equal(fixedResolved.sources[field], "fixed");

    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        fixedPolicy,
        { workItemType: "Bug", title: "Capture type-specific details", [field]: "Agent override" },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
    );
  }
});

test("Work Item Priority policy requires an integer and classification fields stay bounded strings", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const baseInput = { workItemType: "Task", title: "Validate classified task" };
  for (const priority of ["2", 1.5, 0, 100_001]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        policy,
        { ...baseInput, priority },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      policy,
      { ...baseInput, tags: "" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  for (const invalidFields of [
    { areaPath: 42 },
    { assignedTo: "" },
    { tags: ["agent-system", "backend"] },
    { state: "x".repeat(129) },
  ]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        policy,
        { ...baseInput, ...invalidFields },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  policy.tools.azure_devops_create_work_item.fields.priority = { mode: "fixed", value: 1.5 };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(policy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("Work Item estimate and activity fields support independent Agent/fixed policy with numeric validation", () => {
  const values = {
    originalEstimate: 1.25,
    remainingWork: 2.5,
    completedWork: 0.75,
    activity: "Development",
    storyPoints: 3.5,
    effort: 5.5,
    size: 8.25,
    businessValue: 0,
  };
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_work_item",
    policy,
    { workItemType: "Task", title: "Estimate task", ...values },
    { organization: "contoso" },
  );
  assert.deepEqual(Object.fromEntries(Object.keys(values).map((field) => [field, agentResolved.parameters[field]])), values);
  for (const field of Object.keys(values)) assert.equal(agentResolved.sources[field], "agent");

  for (const [field, value] of Object.entries(values)) {
    const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    fixedPolicy.tools.azure_devops_create_work_item.fields[field] = { mode: "fixed", value };
    const fixedResolved = resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      fixedPolicy,
      { workItemType: "Task", title: "Estimate task" },
      { organization: "contoso" },
    );
    assert.equal(fixedResolved.parameters[field], value);
    assert.equal(fixedResolved.sources[field], "fixed");
  }

  for (const invalid of [
    { originalEstimate: -0.01 },
    { remainingWork: Number.POSITIVE_INFINITY },
    { completedWork: Number.NaN },
    { storyPoints: "3.5" },
    { effort: -1 },
    { size: Number.NEGATIVE_INFINITY },
    { businessValue: 1.5 },
    { businessValue: -1 },
    { activity: "  " },
    { activity: "x".repeat(129) },
  ]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_work_item",
        policy,
        { workItemType: "Task", title: "Estimate task", ...invalid },
        { organization: "contoso" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
    );
  }

  for (const [field, value] of [["originalEstimate", -0.5], ["storyPoints", Number.POSITIVE_INFINITY], ["businessValue", 1.5]] as const) {
    const invalidFixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    invalidFixedPolicy.tools.azure_devops_create_work_item.fields[field] = { mode: "fixed", value };
    assert.throws(
      () => assertAzureDevOpsParameterPolicy(invalidFixedPolicy, "ado-project"),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
    );
  }

  const overriddenPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  overriddenPolicy.tools.azure_devops_create_work_item.fields.originalEstimate = { mode: "fixed", value: 1.25 };
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_work_item",
      overriddenPolicy,
      { workItemType: "Task", title: "Estimate task", originalEstimate: 2.5 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_clone_repository",
      createDefaultAzureDevOpsParameterPolicy("ado-project"),
      { repositoryName: "repository", depth: 0 },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
});

test("Wiki page policy supports Agent and fixed values while retaining shared context", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const content = "# Setup\n\nKeep the Markdown line breaks.\n";
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_write_wiki_page",
      policy,
      { path: "Guides/Setup", content },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_MISSING"),
  );

  const derivedResolved = resolveAzureDevOpsToolCall(
    "azure_devops_write_wiki_page",
    policy,
    { path: "Guides/Setup", content },
    { organization: "contoso", wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f" },
  );
  assert.equal(derivedResolved.parameters.wikiIdentifier, "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f");
  assert.equal(derivedResolved.sources.wikiIdentifier, "derived");

  policy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier = { mode: "agent", required: true };
  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_write_wiki_page",
    policy,
    { wikiIdentifier: "Project Wiki", path: "Guides/Setup", content },
    { organization: "contoso" },
  );

  assert.deepEqual(agentResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    wikiIdentifier: "Project Wiki",
    path: "Guides/Setup",
    content,
  });
  assert.equal(agentResolved.sources.organization, "derived");
  assert.equal(agentResolved.sources.project, "fixed");
  assert.equal(agentResolved.sources.content, "agent");

  policy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier = { mode: "fixed", required: true, value: "Project Wiki" };
  policy.tools.azure_devops_write_wiki_page.fields.path = { mode: "fixed", required: true, value: "/Guides/Setup" };
  policy.tools.azure_devops_write_wiki_page.fields.content = { mode: "fixed", required: true, value: content };
  const fixedResolved = resolveAzureDevOpsToolCall(
    "azure_devops_write_wiki_page",
    policy,
    {},
    { organization: "contoso" },
  );
  assert.equal(fixedResolved.parameters.content, content);
  assert.equal(fixedResolved.sources.content, "fixed");
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_write_wiki_page",
      policy,
      { content: "# Different page" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  const agentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  agentPolicy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier = { mode: "agent", required: true };
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_write_wiki_page",
      agentPolicy,
      { wikiIdentifier: "Project Wiki", path: "/Guides/Setup", content: "x".repeat(100_001) },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
});

test("Wiki tools can derive the selected ADO Project and cannot accept an Agent Organization", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_list_wikis.fields.project = { mode: "derived", required: true };
  policy.tools.azure_devops_write_wiki_page.fields.project = { mode: "derived", required: true };
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_list_wikis",
    policy,
    {},
    { organization: "contoso", project: "ado-project" },
  );
  assert.deepEqual(resolved.parameters, { organization: "contoso", project: "ado-project" });
  assert.equal(resolved.sources.project, "derived");

  const writeResolved = resolveAzureDevOpsToolCall(
    "azure_devops_write_wiki_page",
    policy,
    { path: "/Spec", content: "# Spec" },
    { organization: "contoso", project: "ado-project", wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f" },
  );
  assert.equal(writeResolved.parameters.wikiIdentifier, "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f");
  assert.equal(writeResolved.sources.wikiIdentifier, "derived");

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_list_wikis",
      policy,
      { organization: "other-org" },
      { organization: "contoso", project: "ado-project" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
});

test("repository list resolves Organization and Project from the effective Azure DevOps context", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_list_repositories",
    policy,
    {},
    { organization: "contoso", project: "ado-project" },
  );

  assert.deepEqual(resolved.parameters, { organization: "contoso", project: "ado-project" });
  assert.deepEqual(resolved.sources, { organization: "derived", project: "fixed" });
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_list_repositories",
      policy,
      { project: "other-project" },
      { organization: "contoso", project: "ado-project" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_list_repositories",
      policy,
      { organization: "other-org" },
      { organization: "contoso", project: "ado-project" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
});

test("Pipeline policy exposes only bounded pagination and verified repository/YAML inputs", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const listResolved = resolveAzureDevOpsToolCall(
    "azure_devops_list_pipelines",
    policy,
    { continuationToken: "page-2" },
    { organization: "contoso", project: "ado-project" },
  );
  assert.deepEqual(listResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    continuationToken: "page-2",
  });
  assert.deepEqual(listResolved.sources, {
    organization: "derived",
    project: "fixed",
    continuationToken: "agent",
  });
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_list_pipelines", policy, { continuationToken: "x".repeat(2_001) }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_list_pipelines", policy, { organization: "other-org" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );

  const createInput = {
    repositoryReference: "azure-devops://contoso/ado-project/11111111-1111-4111-8111-111111111111",
    name: "CI",
    yamlPath: "pipelines/ci.yml",
    folder: "\\Build\\CI",
  };
  const createResolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_pipeline",
    policy,
    createInput,
    { organization: "contoso", project: "ado-project" },
  );
  assert.deepEqual(createResolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    ...createInput,
  });
  assert.equal(createResolved.sources.yamlPath, "agent");
  assert.equal(policy.tools.azure_devops_create_pipeline.fields.organization?.mode, "derived");
  assert.equal(policy.tools.azure_devops_create_pipeline.fields.project?.mode, "fixed");
  assert.equal(policy.tools.azure_devops_create_pipeline.fields.name?.required, true);
  assert.equal(policy.tools.azure_devops_create_pipeline.fields.yamlPath?.required, true);
  const invalidListPolicy = structuredClone(policy);
  invalidListPolicy.tools.azure_devops_list_pipelines.fields.continuationToken = { mode: "fixed", value: "page-2" };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(invalidListPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
  const derivedYamlPolicy = structuredClone(policy);
  derivedYamlPolicy.tools.azure_devops_create_pipeline.fields.yamlPath = { mode: "derived", required: true };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(derivedYamlPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );

  for (const yamlPath of ["/pipelines/ci.yml", "../ci.yml", "pipelines/../ci.yml", "pipeline.yaml/", "pipeline.json", "pipelines\\ci.yml"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_pipeline",
        policy,
        { ...createInput, yamlPath },
        { organization: "contoso", project: "ado-project" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
      `invalid YAML path should be rejected: ${yamlPath}`,
    );
  }
  for (const folder of ["\\..\\outside", "Build\\..\\outside", "Build//CI", "\\Build\\CI\\"]) {
    assert.throws(
      () => resolveAzureDevOpsToolCall(
        "azure_devops_create_pipeline",
        policy,
        { ...createInput, folder },
        { organization: "contoso", project: "ado-project" },
      ),
      (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
      `invalid Pipeline folder should be rejected: ${folder}`,
    );
  }
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_pipeline",
      policy,
      { ...createInput, project: "another-project" },
      { organization: "contoso", project: "ado-project" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("completes missing fixed remoteName values in legacy policies", () => {
  for (const omitField of [true, false]) {
    const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
    if (omitField) delete policy.tools.azure_devops_git_pull.fields.remoteName;
    else policy.tools.azure_devops_git_pull.fields.remoteName = { mode: "fixed" };

    const completed = assertAzureDevOpsParameterPolicy(
      completeAzureDevOpsParameterPolicy(policy, "ado-project"),
      "ado-project",
    );
    assert.deepEqual(completed.tools.azure_devops_git_pull.fields.remoteName, {
      mode: "fixed",
      value: "origin",
    });
  }
});

test("pull repositoryPath is required and accepts an optional branch", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_git_pull", policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );

  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_git_pull",
    policy,
    { repositoryPath: "repository/cloned-repo", branch: "feature/pull" },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    branch: "feature/pull",
    organization: "contoso",
    project: "ado-project",
    remoteName: "origin",
    repositoryPath: "repository/cloned-repo",
  });
  assert.equal(resolved.sources.repositoryPath, "agent");
  assert.equal(resolved.sources.remoteName, "fixed");

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_git_pull",
      policy,
      { repositoryPath: "repository/../outside" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
});

test("configure remote accepts an optional nested repositoryPath with Agent or fixed policy", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_configure_remote",
    policy,
    { repositoryName: "solo-block-stacker", repositoryPath: "repository/solo-block-stacker" },
    { organization: "contoso" },
  );
  assert.equal(agentResolved.parameters.repositoryPath, "repository/solo-block-stacker");
  assert.equal(agentResolved.sources.repositoryPath, "agent");

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_configure_remote",
      policy,
      { repositoryName: "solo-block-stacker", repositoryPath: "../outside" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );

  policy.tools.azure_devops_configure_remote.fields.repositoryPath = {
    mode: "fixed",
    value: "repository/solo-block-stacker",
  };
  const fixedResolved = resolveAzureDevOpsToolCall(
    "azure_devops_configure_remote",
    policy,
    { repositoryName: "solo-block-stacker" },
    { organization: "contoso" },
  );
  assert.equal(fixedResolved.parameters.repositoryPath, "repository/solo-block-stacker");
  assert.equal(fixedResolved.sources.repositoryPath, "fixed");
});

test("fixed values win over agent input and conflicting values are rejected", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_repository",
    policy,
    { project: "ado-project", repositoryName: "new-repository" },
    { organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryName: "new-repository",
  });
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_repository",
      policy,
      { project: "other-project", repositoryName: "new-repository" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("fixed project policy must match the current ADO context while agent project policy remains allowed", () => {
  const fixedPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  assert.throws(
    () => assertAzureDevOpsProjectContext(fixedPolicy, "another-ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PROJECT_CONTEXT_MISMATCH"),
  );

  const agentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  for (const tool of AZURE_DEVOPS_TOOL_NAMES) {
    if (tool === "azure_devops_create_work_item"
      || tool === "azure_devops_get_work_item"
      || tool === "azure_devops_list_work_item_revisions"
      || tool === "azure_devops_update_work_item"
      || tool === "azure_devops_publish_pipeline_yaml"
      || tool === "azure_devops_preview_pipeline"
      || tool === "azure_devops_run_pipeline"
      || tool === "azure_devops_get_pipeline_run"
      || tool === "azure_devops_create_pull_request"
      || tool === "azure_devops_get_pull_request"
      || tool === "azure_devops_list_pull_requests") continue;
    agentPolicy.tools[tool].fields.project = { mode: "agent", required: true };
  }
  assert.doesNotThrow(() => assertAzureDevOpsProjectContext(agentPolicy, "ado-project"));
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_repository",
    agentPolicy,
    { project: "another-ado-project", repositoryName: "repo" },
    { organization: "contoso" },
  );
  assert.equal(resolved.parameters.project, "another-ado-project");

  const workItemAgentProjectPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  workItemAgentProjectPolicy.tools.azure_devops_create_work_item.fields.project = { mode: "agent", required: true };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(workItemAgentProjectPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
  const workItemGetAgentProjectPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  workItemGetAgentProjectPolicy.tools.azure_devops_get_work_item.fields.project = { mode: "agent", required: true };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(workItemGetAgentProjectPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
  const workItemRevisionsAgentProjectPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  workItemRevisionsAgentProjectPolicy.tools.azure_devops_list_work_item_revisions.fields.project = { mode: "agent", required: true };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(workItemRevisionsAgentProjectPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("agent fields are required and schema-validated per call", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_push", policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_push", policy, { branch: "", repositoryPath: "repository/repo" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );
});

test("push repositoryPath is required and supports UI-fixed or Agent-provided values", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_push", policy, {}, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_REQUIRED"),
  );

  const agentResolved = resolveAzureDevOpsToolCall(
    "azure_devops_push",
    policy,
    { branch: "main", repositoryPath: "repository/cloned-repo" },
    { organization: "contoso" },
  );
  assert.equal(agentResolved.parameters.repositoryPath, "repository/cloned-repo");
  assert.equal(agentResolved.sources.repositoryPath, "agent");
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_push", policy, { branch: "main", repositoryPath: "../outside" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"),
  );

  policy.tools.azure_devops_push.fields.repositoryPath = {
    mode: "fixed",
    required: true,
    value: "repository/pinned-repo",
  };
  const fixedResolved = resolveAzureDevOpsToolCall("azure_devops_push", policy, { branch: "main" }, { organization: "contoso" });
  assert.equal(fixedResolved.parameters.repositoryPath, "repository/pinned-repo");
  assert.equal(fixedResolved.sources.repositoryPath, "fixed");
  assert.throws(
    () => resolveAzureDevOpsToolCall("azure_devops_push", policy, { branch: "main", repositoryPath: "repository/other-repo" }, { organization: "contoso" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );

  policy.tools.azure_devops_push.fields.repositoryPath = { mode: "agent", required: false };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(policy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );

  const invalidFixedPathPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  invalidFixedPathPolicy.tools.azure_devops_push.fields.repositoryPath = {
    mode: "fixed",
    required: true,
    value: "../outside",
  };
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(invalidFixedPathPolicy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("preserves an explicit false required value for default-required Agent fields", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_push.fields.branch = { mode: "agent", required: false };

  const normalized = assertAzureDevOpsParameterPolicy(policy, "ado-project");
  assert.equal(normalized.tools.azure_devops_push.fields.branch?.required, false);
  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_push",
    normalized,
    { repositoryPath: "repository/cloned-repo" },
    { organization: "contoso" },
  );
  assert.equal(resolved.parameters.branch, undefined);
});

test("does not allow required fixed or derived semantics to be disabled", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_create_repository.fields.project = {
    mode: "fixed",
    required: false,
    value: "ado-project",
  };

  assert.throws(
    () => assertAzureDevOpsParameterPolicy(policy, "ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_POLICY_INVALID"),
  );
});

test("derived push branch values are accepted only from the controlled derived context", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_push.fields.branch = { mode: "derived", required: true };

  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_push",
    policy,
    { repositoryPath: "repository/cloned-repo" },
    { branch: "feature/current", organization: "contoso" },
  );
  assert.deepEqual(resolved.parameters, {
      branch: "feature/current",
      organization: "contoso",
      project: "ado-project",
      repositoryPath: "repository/cloned-repo",
      remoteName: "origin",
  });
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_push",
      policy,
      { branch: "agent-override", repositoryPath: "repository/cloned-repo" },
      { branch: "feature/current", organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
});

test("derived, organization, and credential fields cannot be supplied by an Agent", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");

  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_create_repository",
      policy,
      { organization: "attacker", repositoryName: "repo" },
      {},
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_configure_remote",
      policy,
      { repositoryName: "repo", remoteUrl: "https://attacker.example/repo.git" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
  assert.throws(
    () => resolveAzureDevOpsToolCall(
      "azure_devops_push",
      policy,
      { branch: "main", credential: "pat-plaintext", repositoryPath: "repository/cloned-repo" },
      { organization: "contoso" },
    ),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_DERIVED_PARAMETER_INPUT"),
  );
});

test("ADO Project can be explicitly unlocked while OpenCode and ADO project identities remain separate", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_create_repository.fields.project = { mode: "agent", required: true };

  const resolved = resolveAzureDevOpsToolCall(
    "azure_devops_create_repository",
    policy,
    { project: "another-ado-project", repositoryName: "repo" },
    { organization: "contoso" },
  );
  assert.equal(resolved.parameters.project, "another-ado-project");

  const context = resolveAzureDevOpsEffectiveContext({
    openCodeProject: "opencode-project",
    settings: {
      organization: "contoso",
      project: "ado-project",
      team: "platform",
      parameterPolicy: policy,
    },
  });

  assert.equal(context.openCodeProject, "opencode-project");
  assert.equal(context.adoProject, "ado-project");
  assert.equal(context.openCodeProject === context.adoProject, false);
  assert.equal(context.organization, "contoso");
  assert.equal(JSON.stringify(context).includes("pat-plaintext"), false);
});

test("effective context rejects a persisted fixed policy from an older ADO project", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("old-ado-project");

  assert.throws(
    () => resolveAzureDevOpsEffectiveContext({
      openCodeProject: "opencode-project",
      settings: { project: "current-ado-project", parameterPolicy: policy },
    }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PROJECT_CONTEXT_MISMATCH"),
  );
});

test("migrates persisted policies by defaulting tools introduced after the saved context", () => {
  const currentPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const legacyPolicy = structuredClone(currentPolicy) as {
    version: number;
    tools: Record<string, unknown>;
  };
  delete legacyPolicy.tools.azure_devops_git_pull;

  const effective = resolveAzureDevOpsEffectiveContext({
    openCodeProject: "agent",
    settings: { project: "ado-project", parameterPolicy: legacyPolicy },
  });
  assert.deepEqual(effective.parameterPolicy.tools.azure_devops_git_pull, currentPolicy.tools.azure_devops_git_pull);
  assert.deepEqual(effective.parameterPolicy.tools.azure_devops_push, currentPolicy.tools.azure_devops_push);

  const merged = mergeAzureDevOpsContext(
    { project: "ado-project", parameterPolicy: legacyPolicy },
    { team: "Platform" },
  );
  assert.deepEqual((merged.parameterPolicy as typeof currentPolicy).tools.azure_devops_git_pull, currentPolicy.tools.azure_devops_git_pull);
});

test("Extension backend rejects a fixed project policy mismatch before loading the package runtime", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("old-ado-project");

  await assert.rejects(
    () => runBackendWithPolicy(policy, {
      branch: "main",
      organization: "contoso",
      project: "old-ado-project",
      repositoryPath: "repository/cloned-repo",
      remoteName: "origin",
      setUpstream: false,
    }, {
      branch: "agent",
      organization: "derived",
      project: "fixed",
      repositoryPath: "agent",
      remoteName: "fixed",
      setUpstream: "agent",
    }, "current-ado-project"),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PROJECT_CONTEXT_MISMATCH"),
  );
});

test("Extension backend rejects verified push plans whose values or sources drift before loading the package runtime", async () => {
  const oldPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const oldResolvedValues = {
    branch: "main",
    organization: "contoso",
    project: "ado-project",
    repositoryPath: "repository/cloned-repo",
    remoteName: "origin",
    setUpstream: false,
  };
  const oldSources = {
    branch: "agent",
    organization: "derived",
    project: "fixed",
    repositoryPath: "agent",
    remoteName: "fixed",
    setUpstream: "agent",
  } as const;

  const valueDriftPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  valueDriftPolicy.tools.azure_devops_push.fields.remoteName = { mode: "fixed", value: "deploy" };
  await assert.rejects(
    () => runBackendWithPolicy(valueDriftPolicy, oldResolvedValues, oldSources),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_RESOLVED_PLAN_MISMATCH"),
  );

  const sourceDriftPolicy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  sourceDriftPolicy.tools.azure_devops_push.fields.setUpstream = { mode: "fixed", value: false };
  await assert.rejects(
    () => runBackendWithPolicy(sourceDriftPolicy, oldResolvedValues, oldSources),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_RESOLVED_PLAN_MISMATCH"),
  );

  assert.equal(oldPolicy.tools.azure_devops_push.fields.remoteName?.value, "origin");
});

test("Extension context settings round-trip policy and preserve unrelated values without storing credentials", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const context = mergeAzureDevOpsContext(
    { keep: "unchanged", project: "ado-project", team: "platform", wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", parameterPolicy: policy },
    { board: "kanban", organization: "fabrikam", wikiIdentifier: "new-wiki-id", parameterPolicy: policy },
  );
  assert.equal(context.keep, "unchanged");
  assert.equal(context.team, "platform");
  assert.equal(context.board, "kanban");
  assert.deepEqual(context.parameterPolicy, policy);
  assert.equal(context.organization, "fabrikam");
  assert.equal(context.wikiIdentifier, "new-wiki-id");
  assert.equal(JSON.stringify(context).includes("pat-plaintext"), false);
});

test("context patches reject plaintext credential-shaped values", () => {
  assert.throws(
    () => mergeAzureDevOpsContext({}, { token: "pat-plaintext" }),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_PLAINTEXT_SECRET"),
  );
});

test("runtime Agent input receives the latest sanitized effective Azure DevOps context", () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("new-ado-project");
  const input = withAzureDevOpsRuntimeContext(
    { request: "use the repository tool", azureDevOpsContext: { adoProject: "stale-project", token: "stale-token" } },
    {
      azureDevOps: { organization: "contoso", project: "new-ado-project", parameterPolicy: policy },
    },
    "opencode-project",
  );

  const context = input.azureDevOpsContext as Record<string, unknown>;
  assert.equal(context.openCodeProject, "opencode-project");
  assert.equal(context.adoProject, "new-ado-project");
  assert.deepEqual(context.parameterPolicy, policy);
  assert.equal(JSON.stringify(input).includes("pat-plaintext"), false);
  assert.equal(JSON.stringify(input).includes("stale-project"), false);
  assert.equal(JSON.stringify(input).includes("stale-token"), false);
});

test("get-git-credential resolves from project context without requiring a repository identity", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("AI_Traning");
  let backendLoaded = false;
  const service = new ExtensionBackendService(
    {
      readBackend: async () => {
        backendLoaded = true;
        return {
          content: Buffer.from(`${policyHookExport} export async function activate() {
            return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
          }`),
          effectiveScope: "project",
          extensionId: "azure-devops-platform",
          packageSha256: "a".repeat(64),
          version: "1.6.20",
        };
      },
      readSettings: async () => ({ azureDevOps: { organization: "contoso", project: "AI_Traning", parameterPolicy: policy } }),
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };

  const result = await service.handle({
    body: { agentInput: {}, tool: "azure_devops_clone_repository" },
    headers: {},
    method: "POST",
    params: { "*": "get-git-credential", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };

  assert.equal(backendLoaded, true);
  assert.equal(result.tool, "azure_devops_clone_repository");
  assert.deepEqual(result.parameters, { organization: "contoso", project: "AI_Traning" });
  assert.deepEqual(result.sources, { organization: "derived", project: "fixed" });

  const pullPlan = await service.handle({
    body: {
      agentInput: { branch: "main", repositoryPath: "repository/selected-repo" },
      tool: "azure_devops_git_pull",
    },
    headers: {},
    method: "POST",
    params: { "*": "pull-plan", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };
  assert.equal(pullPlan.tool, "azure_devops_git_pull");
  assert.deepEqual(pullPlan.parameters, {
    branch: "main",
    organization: "contoso",
    project: "AI_Traning",
    remoteName: "origin",
    repositoryPath: "repository/selected-repo",
  });
  assert.deepEqual(pullPlan.sources, {
    branch: "agent",
    organization: "derived",
    project: "fixed",
    remoteName: "fixed",
    repositoryPath: "agent",
  });

  await assert.rejects(
    () => service.handle({
      body: { agentInput: {}, tool: "azure_devops_clone_repository" },
      headers: {},
      method: "POST",
      params: { "*": "clone-repository", extensionId: "azure-devops-platform" },
      query: { project: "managed-project", scope: "project" },
    } as never, reply as never),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_REPOSITORY_REFERENCE_REQUIRED"),
  );
});

test("resolves Wiki tool calls through the shared Organization and selected Project context", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_write_wiki_page.fields.project = { mode: "derived", required: true };
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export async function activate() {
          return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
        }`),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "b".repeat(64),
        version: "1.6.33",
      }),
      readSettings: async () => ({
        azureDevOps: {
          organization: "contoso",
          project: "ado-project",
          wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f",
          parameterPolicy: policy,
        },
      }),
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };

  const resolved = await service.handle({
    body: {
      tool: "azure_devops_write_wiki_page",
      agentInput: { wikiIdentifier: "AI_Traning_wiki", path: "/Guides/Setup", content: "# Setup\n" },
    },
    headers: {},
    method: "POST",
    params: { "*": "write-wiki-page", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };

  assert.equal(resolved.tool, "azure_devops_write_wiki_page");
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f",
    path: "/Guides/Setup",
    content: "# Setup\n",
  });
  assert.deepEqual(resolved.sources, {
    organization: "derived",
    project: "derived",
    wikiIdentifier: "derived",
    path: "agent",
    content: "agent",
  });
});

test("routes repository list calls through BFF context and enforces the selected fixed Project", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export async function activate() {
          return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
        }`),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "d".repeat(64),
        version: "1.6.36",
      }),
      readSettings: async () => ({ azureDevOps: { organization: "contoso", project: "ado-project", parameterPolicy: policy } }),
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };

  const resolved = await service.handle({
    body: { tool: "azure_devops_list_repositories", agentInput: {} },
    headers: {},
    method: "POST",
    params: { "*": "list-repositories", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };

  assert.equal(resolved.tool, "azure_devops_list_repositories");
  assert.deepEqual(resolved.parameters, { organization: "contoso", project: "ado-project" });
  assert.deepEqual(resolved.sources, { organization: "derived", project: "fixed" });

  await assert.rejects(
    () => service.handle({
      body: { tool: "azure_devops_list_repositories", agentInput: { project: "other-project" } },
      headers: {},
      method: "POST",
      params: { "*": "list-repositories", extensionId: "azure-devops-platform" },
      query: { project: "managed-project", scope: "project" },
    } as never, reply as never),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("routes Pipeline tools through the project BFF and resolves only context-owned Organization and Project", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export async function activate() {
          return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
        }`),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "e".repeat(64),
        version: "1.6.36",
      }),
      readSettings: async (_extensionId: string, _scope: string, project: string) => {
        assert.equal(project, "managed-project");
        return { azureDevOps: { organization: "contoso", project: "ado-project", parameterPolicy: policy } };
      },
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };

  const list = await service.handle({
    body: { tool: "azure_devops_list_pipelines", agentInput: { continuationToken: "page-2" } },
    headers: {},
    method: "POST",
    params: { "*": "list-pipelines", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };
  assert.equal(list.tool, "azure_devops_list_pipelines");
  assert.deepEqual(list.parameters, {
    organization: "contoso",
    project: "ado-project",
    continuationToken: "page-2",
  });
  assert.deepEqual(list.sources, { organization: "derived", project: "fixed", continuationToken: "agent" });

  const create = await service.handle({
    body: {
      tool: "azure_devops_create_pipeline",
      agentInput: {
        repositoryID: "11111111-1111-4111-8111-111111111111",
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      },
    },
    headers: {},
    method: "POST",
    params: { "*": "create-pipeline", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };
  assert.equal(create.tool, "azure_devops_create_pipeline");
  assert.deepEqual(create.parameters, {
    organization: "contoso",
    project: "ado-project",
    repositoryID: "11111111-1111-4111-8111-111111111111",
    name: "CI",
    yamlPath: "pipelines/ci.yml",
  });
  assert.deepEqual(create.sources, {
    organization: "derived",
    project: "fixed",
    repositoryID: "agent",
    name: "agent",
    yamlPath: "agent",
  });

  await assert.rejects(
    () => service.handle({
      body: {
        tool: "azure_devops_create_pipeline",
        agentInput: {
          repositoryID: "11111111-1111-4111-8111-111111111111",
          name: "CI",
          yamlPath: "pipelines/ci.yml",
          project: "other-project",
        },
      },
      headers: {},
      method: "POST",
      params: { "*": "create-pipeline", extensionId: "azure-devops-platform" },
      query: { project: "managed-project", scope: "project" },
    } as never, reply as never),
    (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
  );
});

test("resolves Work Item creation through the fixed ADO Project and shared Organization context", async () => {
  const policy = createDefaultAzureDevOpsParameterPolicy("ado-project");
  policy.tools.azure_devops_create_work_item.fields.assignedTo = {
    mode: "fixed",
    value: "fixed-owner@example.com",
  };
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export async function activate() {
          return { handle: async ({ request }) => ({ body: request.extensionContext.azureDevOps.resolvedToolCall }) };
        }`),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "c".repeat(64),
        version: "1.6.36",
      }),
      readSettings: async () => ({ azureDevOps: { organization: "contoso", project: "ado-project", parameterPolicy: policy } }),
    } as never,
    [],
  );
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code() { return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };
  const markdown = "# Details\n\n- raw Markdown\n";
  const reproSteps = "## Repro\n\n1. Create the item\n2. Observe the failure\n";
  const systemInfo = "- Browser: Chromium\n- Version: 1.2.3\n";
  const acceptanceCriteria = "- [ ] The item keeps raw Markdown\n";

  const resolved = await service.handle({
    body: {
      tool: "azure_devops_create_work_item",
      agentInput: {
        workItemType: "User Story",
        title: "Create from the shared context",
        description: markdown,
        parentId: 321,
        areaPath: "Contoso\\Platform",
        iterationPath: "Contoso\\Sprint 1",
        reproSteps,
        systemInfo,
        severity: "2 - High",
        acceptanceCriteria,
        priority: 2,
        tags: "agent-system; backend",
        state: "Active",
      },
    },
    headers: {},
    method: "POST",
    params: { "*": "create-work-item", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, reply as never) as {
    parameters: Record<string, unknown>;
    sources: Record<string, unknown>;
    tool: string;
  };

  assert.equal(resolved.tool, "azure_devops_create_work_item");
  assert.deepEqual(resolved.parameters, {
    organization: "contoso",
    project: "ado-project",
    workItemType: "User Story",
    title: "Create from the shared context",
    description: markdown,
    parentId: 321,
    areaPath: "Contoso\\Platform",
    iterationPath: "Contoso\\Sprint 1",
    reproSteps,
    systemInfo,
    severity: "2 - High",
    acceptanceCriteria,
    assignedTo: "fixed-owner@example.com",
    priority: 2,
    tags: "agent-system; backend",
    state: "Active",
  });
  assert.deepEqual(resolved.sources, {
    organization: "derived",
    project: "fixed",
    workItemType: "agent",
    title: "agent",
    description: "agent",
    parentId: "agent",
    areaPath: "agent",
    iterationPath: "agent",
    reproSteps: "agent",
    systemInfo: "agent",
    severity: "agent",
    acceptanceCriteria: "agent",
    assignedTo: "fixed",
    priority: "agent",
    tags: "agent",
    state: "agent",
  });
});

function isCodedError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function runBackendWithPolicy(
  policy: ReturnType<typeof createDefaultAzureDevOpsParameterPolicy>,
  verifiedValues: Record<string, unknown>,
  verifiedSources: Record<string, unknown>,
  currentAdoProject = "ado-project",
): Promise<unknown> {
  const service = new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: Buffer.from(`${policyHookExport} export function activate() { throw new Error("驗證失敗前不得啟動套件 runtime"); }`),
        extensionId: "azure-devops-platform",
        effectiveScope: "project",
        packageSha256: "policy-validation-only",
        version: "2.0.2",
      }),
      readSettings: async () => ({ azureDevOps: { organization: "contoso", project: currentAdoProject, parameterPolicy: policy } }),
    } as never,
    [],
  );

  return service.handle({
    body: {
      agentInput: { branch: "main", repositoryPath: "repository/cloned-repo", setUpstream: false },
      tool: "azure_devops_push",
      verifiedResolvedSources: verifiedSources,
      verifiedResolvedValues: verifiedValues,
    },
    headers: {},
    method: "POST",
    params: { "*": "push-credential", extensionId: "azure-devops-platform" },
    query: { project: "managed-project", scope: "project" },
  } as never, {} as never);
}
