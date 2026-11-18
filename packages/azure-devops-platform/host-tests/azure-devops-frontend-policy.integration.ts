import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRequiredPipelineYamlPolicy,
  assertRequiredPipelinePolicy,
  assertPullRequestListPolicy,
  assertRequiredPullRequestPolicy,
  assertRequiredPullRequestDetailsPolicy,
  assertParameterPolicyForSave,
  assertRequiredWorkItemPolicy,
  assertRequiredWorkItemGetPolicy,
  assertRequiredWorkItemRevisionsPolicy,
  assertRequiredWorkItemUpdatePolicy,
  compactParameterPolicy,
  normalizeParameterPolicy,
  parsePolicyArrayText,
  readPolicyInputValue,
  normalizeWikis,
  mergeWikis,
  safeContextDocument,
  selectWikiIdentifier,
} from "../extension-packages/azure-devops-platform/frontend/entry.js";
import { assertAzureDevOpsParameterPolicy } from "../policy/index.ts";

test("frontend policy persistence keeps an explicit false required flag", () => {
  const policy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          branch: { mode: "agent", required: false },
        },
      },
    },
  }, "ado-project");

  assert.equal(policy.tools.azure_devops_push.fields.branch.required, false);
  assert.equal(JSON.stringify(policy).includes('"required":false'), true);

  const compact = compactParameterPolicy(policy, "ado-project");
  assert.deepEqual(compact, {
    version: 1,
    tools: { azure_devops_push: { fields: { branch: { required: false } } } },
  });
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), policy);
});

test("frontend policy persistence retains default required semantics when no override exists", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");

  assert.equal(policy.tools.azure_devops_push.fields.branch.required, true);
  assert.equal(policy.tools.azure_devops_create_repository.fields.project.required, true);
});

test("shared frontend policy save validation preserves requiredness and validation errors", () => {
  const validPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  assert.doesNotThrow(() => assertParameterPolicyForSave(validPolicy));

  const optionalWorkItemID = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_get_work_item: { fields: { workItemId: { mode: "agent", required: false } } } },
  }, "ado-project");
  optionalWorkItemID.tools.azure_devops_get_work_item.fields.workItemId = { mode: "agent", required: false };
  assert.throws(
    () => assertParameterPolicyForSave(optionalWorkItemID),
    /Work Item ID 必須在每次呼叫中提供，或切換成 fixed 模式。/,
  );

  const invalidRepositoryPath = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  invalidRepositoryPath.tools.azure_devops_push.fields.repositoryPath = { mode: "fixed", value: "../outside" };
  assert.throws(
    () => assertParameterPolicyForSave(invalidRepositoryPath),
    /Repository path 為必填，請輸入 repository\/<repo-name>/,
  );

  const conflictingPullRequestSelectors = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  conflictingPullRequestSelectors.tools.azure_devops_list_pull_requests.fields.repositoryID = { mode: "agent", required: true };
  conflictingPullRequestSelectors.tools.azure_devops_list_pull_requests.fields.repositoryName = { mode: "agent", required: true };
  assert.throws(
    () => assertParameterPolicyForSave(conflictingPullRequestSelectors),
    /PR 清單的 Repository reference、Repository ID 與 Repository name 固定／必填設定必須最多選擇一種。/,
  );
});

test("frontend pull request policy round-trips scalar fixed values and keeps the shared Project fixed", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = policy.tools.azure_devops_create_pull_request.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.repositoryID, { mode: "agent", required: false });
  assert.deepEqual(fields.sourceRefName, { mode: "agent", required: true });
  assert.deepEqual(fields.targetRefName, { mode: "agent", required: true });
  assert.deepEqual(fields.title, { mode: "agent", required: true });
  assert.deepEqual(fields.description, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredPullRequestPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  fields.repositoryName = { mode: "fixed", value: "api" };
  fields.sourceRefName = { mode: "fixed", required: true, value: "refs/heads/release/2026" };
  fields.title = { mode: "fixed", required: true, value: "Prepare release" };
  fields.description = { mode: "fixed", value: "" };
  fields.isDraft = { mode: "fixed", value: false };
  fields.supportsIterations = { mode: "fixed", value: true };
  assert.doesNotThrow(() => assertRequiredPullRequestPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  const compact = compactParameterPolicy(policy, "ado-project");
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), policy);
  assert.deepEqual(compact.tools.azure_devops_create_pull_request.fields, {
    repositoryName: { mode: "fixed", value: "api" },
    sourceRefName: { mode: "fixed", value: "refs/heads/release/2026" },
    title: { mode: "fixed", value: "Prepare release" },
    description: { mode: "fixed", value: "" },
    isDraft: { mode: "fixed", value: false },
    supportsIterations: { mode: "fixed", value: true },
  });
});

test("frontend pull request details policy bounds the PR ID and commit page controls", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = policy.tools.azure_devops_get_pull_request.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.pullRequestId, { mode: "agent", required: true });
  assert.deepEqual(fields.commitTop, { mode: "agent", required: false });
  assert.deepEqual(fields.commitContinuationToken, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredPullRequestDetailsPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  fields.pullRequestId = { mode: "fixed", required: true, value: 2_147_483_647 };
  fields.commitTop = { mode: "fixed", value: 100 };
  const compact = compactParameterPolicy(policy, "ado-project");
  assert.deepEqual(compact.tools.azure_devops_get_pull_request.fields, {
    pullRequestId: { mode: "fixed", value: 2_147_483_647 },
    commitTop: { mode: "fixed", value: 100 },
  });
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), policy);
  assert.doesNotThrow(() => assertRequiredPullRequestDetailsPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  fields.pullRequestId = { mode: "agent", required: false };
  assert.throws(() => assertRequiredPullRequestDetailsPolicy(policy), /Pull request ID/);
  fields.pullRequestId = { mode: "fixed", value: 2_147_483_648 };
  assert.throws(() => assertRequiredPullRequestDetailsPolicy(policy), /Pull request ID/);
  fields.pullRequestId = { mode: "agent", required: true };
  fields.commitTop = { mode: "fixed", value: 101 };
  assert.throws(() => assertRequiredPullRequestDetailsPolicy(policy), /Commit page size/);
  fields.commitTop = { mode: "agent", required: false };
  fields.commitContinuationToken = { mode: "fixed", value: "fixed-token" };
  assert.throws(() => assertRequiredPullRequestDetailsPolicy(policy), /continuation token/);
});

test("frontend pull request description editor preserves empty and whitespace-only fixed values", () => {
  const descriptionField = { type: "string", label: "Description", allowEmpty: true, maxLength: 100_000, multiline: true };
  assert.equal(readPolicyInputValue({ value: "" }, descriptionField), "");
  assert.equal(readPolicyInputValue({ value: "  " }, descriptionField), "  ");
  assert.equal(readPolicyInputValue({ value: "x".repeat(100_000) }, descriptionField).length, 100_000);
  assert.throws(() => readPolicyInputValue({ value: "x".repeat(100_001) }, descriptionField), /100000 字元上限/);

  const policy = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_pull_request: { fields: { description: { mode: "fixed", value: "" } } } },
  }, "ado-project");
  assert.equal(policy.tools.azure_devops_create_pull_request.fields.description.value, "");
  assert.doesNotThrow(() => assertRequiredPullRequestPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));
  assert.deepEqual(compactParameterPolicy(policy, "ado-project").tools.azure_devops_create_pull_request.fields, {
    description: { mode: "fixed", value: "" },
  });
});

test("frontend pull request policy rejects missing required fields, invalid refs, and conflicting fixed selectors", () => {
  const missingRequired = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_pull_request: { fields: { title: { mode: "agent", required: false } } } },
  }, "ado-project");
  missingRequired.tools.azure_devops_create_pull_request.fields.title.required = false;
  assert.throws(() => assertRequiredPullRequestPolicy(missingRequired), /Title 必須/);

  const malformedRef = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pull_request: {
        fields: { sourceRefName: { mode: "fixed", value: "refs/heads/../release" } },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPullRequestPolicy(malformedRef), /Source branch ref 為必填/);

  const conflictingSelectors = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pull_request: {
        fields: {
          repositoryID: { mode: "fixed", value: "11111111-1111-4111-8111-111111111111" },
          repositoryName: { mode: "fixed", value: "api" },
        },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPullRequestPolicy(conflictingSelectors), /最多選擇一種/);
});

test("frontend PR list policy round-trips verified selectors, filters, status choices, and bounded paging", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = policy.tools.azure_devops_list_pull_requests.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.repositoryName, { mode: "agent", required: false });
  assert.deepEqual(fields.sourceRefName, { mode: "agent", required: false });
  assert.deepEqual(fields.status, { mode: "agent", required: false });
  assert.deepEqual(fields.top, { mode: "agent", required: false });
  assert.deepEqual(fields.skip, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertPullRequestListPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  Object.assign(fields, {
    repositoryName: { mode: "fixed", value: "api" },
    sourceRefName: { mode: "fixed", value: "refs/heads/feature/change" },
    targetRefName: { mode: "fixed", value: "refs/heads/main" },
    status: { mode: "fixed", value: "all" },
    top: { mode: "fixed", value: 100 },
    skip: { mode: "fixed", value: 0 },
  });
  assert.doesNotThrow(() => assertPullRequestListPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));
  const compact = compactParameterPolicy(policy, "ado-project");
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), policy);
  assert.deepEqual(compact.tools.azure_devops_list_pull_requests.fields, {
    repositoryName: { mode: "fixed", value: "api" },
    sourceRefName: { mode: "fixed", value: "refs/heads/feature/change" },
    targetRefName: { mode: "fixed", value: "refs/heads/main" },
    status: { mode: "fixed", value: "all" },
    top: { mode: "fixed", value: 100 },
    skip: { mode: "fixed", value: 0 },
  });

  const invalidFixedStatus = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_list_pull_requests: { fields: { status: { mode: "fixed", value: "pending" } } } },
  }, "ado-project");
  assert.throws(() => assertPullRequestListPolicy(invalidFixedStatus), /PR status 設為 fixed 時必須是有效值/);
  assert.throws(() => assertAzureDevOpsParameterPolicy(invalidFixedStatus, "ado-project"));

  const conflictingSelectors = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_list_pull_requests: {
        fields: {
          repositoryID: { mode: "fixed", value: "11111111-1111-4111-8111-111111111111" },
          repositoryName: { mode: "fixed", value: "api" },
        },
      },
    },
  }, "ado-project");
  assert.throws(() => assertPullRequestListPolicy(conflictingSelectors), /最多選擇一種/);
});

test("frontend pull request policy edits, saves, reloads, and validates JSON list arrays", () => {
  const listValues = {
    reviewerIds: ["11111111-1111-4111-8111-111111111111"],
    workItemIds: [74, 2_147_483_647],
    labels: ["feature", "customer request"],
  };
  const policy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pull_request: {
        fields: Object.fromEntries(Object.entries(listValues).map(([field, value]) => [field, { mode: "fixed", value }])),
      },
    },
  }, "ado-project");
  const fields = policy.tools.azure_devops_create_pull_request.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual({
    reviewerIds: fields.reviewerIds,
    workItemIds: fields.workItemIds,
    labels: fields.labels,
  }, Object.fromEntries(Object.entries(listValues).map(([field, value]) => [field, { mode: "fixed", value }])));
  assert.doesNotThrow(() => assertRequiredPullRequestPolicy(policy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  const compact = compactParameterPolicy(policy, "ado-project");
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), policy);
  assert.deepEqual(compact.tools.azure_devops_create_pull_request.fields, {
    reviewerIds: { mode: "fixed", value: listValues.reviewerIds },
    workItemIds: { mode: "fixed", value: listValues.workItemIds },
    labels: { mode: "fixed", value: listValues.labels },
  });

  const definitions: Record<string, Record<string, unknown>> = {
    reviewerIds: { label: "Reviewer IDs", type: "json-array", arrayItemType: "uuid", maxItems: 50, maxLength: 10_000 },
    workItemIds: { label: "Work Item IDs", type: "json-array", arrayItemType: "integer", itemMinimum: 1, itemMaximum: 2_147_483_647, maxItems: 50, maxLength: 10_000 },
    labels: { label: "Labels", type: "json-array", arrayItemType: "string", itemMaxLength: 128, maxItems: 50, maxLength: 10_000 },
  };
  for (const [field, value] of Object.entries(listValues)) {
    assert.deepEqual(parsePolicyArrayText(JSON.stringify(value, null, 2), definitions[field]), value);
  }
  const invalidInput: Array<[string, string]> = [
    ["reviewerIds", '[{"id":"11111111-1111-4111-8111-111111111111"}]'],
    ["workItemIds", "[0, 2147483648]"],
    ["labels", JSON.stringify(["x".repeat(129)])],
    ["labels", "not valid JSON"],
  ];
  for (const [field, value] of invalidInput) {
    assert.throws(() => parsePolicyArrayText(value, definitions[field]));
  }

  const overCombinedLimit = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pull_request: {
        fields: {
          reviewerIds: { mode: "fixed", value: Array(50).fill("11111111-1111-4111-8111-111111111111") },
          labels: { mode: "fixed", value: Array(40).fill('"'.repeat(100)) },
        },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPullRequestPolicy(overCombinedLimit), /10,000 字元/);
});

test("frontend policy compaction stores only differences and round-trips fixed values and required overrides", () => {
  const fullPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          branch: { mode: "agent", required: false },
          remoteName: { mode: "fixed", value: "upstream" },
        },
      },
    },
  }, "ado-project");
  const compact = compactParameterPolicy(fullPolicy, "ado-project");

  assert.deepEqual(compact, {
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          branch: { required: false },
          remoteName: { value: "upstream" },
        },
      },
    },
  });
  assert.deepEqual(normalizeParameterPolicy(compact, "ado-project"), fullPolicy);
  const fullContext = { organization: "contoso", project: "ado-project", parameterPolicy: fullPolicy };
  const compactContext = { organization: "contoso", project: "ado-project", parameterPolicy: compact };
  assert.ok(Buffer.byteLength(JSON.stringify(fullContext), "utf8") > 4_096);
  assert.ok(Buffer.byteLength(JSON.stringify(compactContext), "utf8") < 4_096);
});

test("frontend Pipeline policies preserve context ownership, required YAML inputs, and continuation behavior", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");

  assert.deepEqual(policy.tools.azure_devops_list_pipelines.fields.organization, { mode: "derived" });
  assert.deepEqual(policy.tools.azure_devops_list_pipelines.fields.project, {
    mode: "fixed",
    required: true,
    value: "ado-project",
  });
  assert.deepEqual(policy.tools.azure_devops_list_pipelines.fields.continuationToken, { mode: "agent", required: false });
  assert.deepEqual(policy.tools.azure_devops_create_pipeline.fields.name, { mode: "agent", required: true });
  assert.deepEqual(policy.tools.azure_devops_create_pipeline.fields.yamlPath, { mode: "agent", required: true });
  assert.deepEqual(policy.tools.azure_devops_create_pipeline.fields.repositoryReference, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));

  const invalidDerived = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pipeline: { fields: { yamlPath: { mode: "derived", required: true } } },
    },
  }, "ado-project");
  assert.equal(invalidDerived.tools.azure_devops_create_pipeline.fields.yamlPath.mode, "agent");
});

test("frontend Pipeline policy rejects missing required fixed values and unsafe fixed YAML paths", () => {
  const missingFixed = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pipeline: {
        fields: { name: { mode: "fixed" }, yamlPath: { mode: "fixed" } },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPipelinePolicy(missingFixed), /Pipeline name 為必填/);

  const invalidYamlPath = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pipeline: {
        fields: { name: { mode: "fixed", value: "CI" }, yamlPath: { mode: "fixed", value: "../ci.yml" } },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPipelinePolicy(invalidYamlPath), /Existing YAML path/);

  const validFixed = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_pipeline: {
        fields: {
          name: { mode: "fixed", value: "CI" },
          yamlPath: { mode: "fixed", value: "pipelines/ci.yml" },
          folder: { mode: "fixed", value: "\\Build\\CI" },
        },
      },
    },
  }, "ado-project");
  assert.doesNotThrow(() => assertRequiredPipelinePolicy(validFixed));
});

test("frontend restores default fixed remoteName for legacy policies before applying them", () => {
  const policy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_git_pull: {
        fields: {
          repositoryPath: { mode: "agent", required: true },
        },
      },
    },
  }, "ado-project");

  assert.deepEqual(policy.tools.azure_devops_git_pull.fields.remoteName, {
    mode: "fixed",
    value: "origin",
  });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(policy, "ado-project"));
});

test("frontend policy keeps push repositoryPath required in Agent and fixed modes", () => {
  const agentPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          repositoryPath: { mode: "agent", required: false },
        },
      },
    },
  }, "ado-project");
  assert.equal(agentPolicy.tools.azure_devops_push.fields.repositoryPath.mode, "agent");
  assert.equal(agentPolicy.tools.azure_devops_push.fields.repositoryPath.required, true);

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          repositoryPath: { mode: "fixed", required: false, value: "repository/pinned-repo" },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_push.fields.repositoryPath, {
    mode: "fixed",
    required: true,
    value: "repository/pinned-repo",
  });

  const disallowedMode = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_push: {
        fields: {
          repositoryPath: { mode: "derived", required: true },
        },
      },
    },
  }, "ado-project");
  assert.equal(disallowedMode.tools.azure_devops_push.fields.repositoryPath.mode, "agent");
});

test("frontend policy keeps pull repositoryPath required and branch optional", () => {
  const agentPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_git_pull: {
        fields: {
          repositoryPath: { mode: "agent", required: false },
        },
      },
    },
  }, "ado-project");
  assert.equal(agentPolicy.tools.azure_devops_git_pull.fields.repositoryPath.mode, "agent");
  assert.equal(agentPolicy.tools.azure_devops_git_pull.fields.repositoryPath.required, true);
  assert.equal(agentPolicy.tools.azure_devops_git_pull.fields.branch.required, false);

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_git_pull: {
        fields: {
          repositoryPath: { mode: "fixed", value: "repository/pinned-repo" },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_git_pull.fields.repositoryPath, {
    mode: "fixed",
    required: true,
    value: "repository/pinned-repo",
  });
});

test("frontend policy exposes optional nested repositoryPath for remote configuration", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  assert.deepEqual(defaultPolicy.tools.azure_devops_configure_remote.fields.repositoryPath, {
    mode: "agent",
    required: false,
  });

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_configure_remote: {
        fields: {
          repositoryPath: { mode: "fixed", value: "repository/solo-block-stacker" },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_configure_remote.fields.repositoryPath, {
    mode: "fixed",
    value: "repository/solo-block-stacker",
  });
});

test("frontend Wiki policy uses shared context and preserves fixed multiline Markdown", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const writeWikiPage = defaultPolicy.tools.azure_devops_write_wiki_page.fields;
  assert.deepEqual(writeWikiPage.organization, { mode: "derived" });
  assert.deepEqual(writeWikiPage.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(writeWikiPage.path, { mode: "agent", required: true });
  assert.deepEqual(defaultPolicy.tools.azure_devops_list_wikis.fields.organization, { mode: "derived" });

  const requiredAgentContent = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_write_wiki_page: { fields: { content: { mode: "agent", required: false } } },
    },
  }, "ado-project");
  assert.equal(requiredAgentContent.tools.azure_devops_write_wiki_page.fields.content.required, true);

  const markdown = "# Guide\n\n- first line\n- second line\n";
  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_write_wiki_page: {
        fields: {
          wikiIdentifier: { mode: "fixed", value: "Project Wiki" },
          path: { mode: "fixed", value: "/Guides/Setup" },
          content: { mode: "fixed", value: markdown },
        },
      },
    },
  }, "ado-project");

  assert.deepEqual(fixedPolicy.tools.azure_devops_write_wiki_page.fields.content, {
    mode: "fixed",
    required: true,
    value: markdown,
  });
});

test("frontend repository-list policy exposes derived Organization and selected ADO Project fields", () => {
  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  assert.deepEqual(policy.tools.azure_devops_list_repositories.fields.organization, { mode: "derived" });
  assert.deepEqual(policy.tools.azure_devops_list_repositories.fields.project, {
    mode: "fixed",
    required: true,
    value: "ado-project",
  });

  const derivedProjectPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_list_repositories: { fields: { project: { mode: "derived" } } },
    },
  }, "ado-project");
  assert.deepEqual(derivedProjectPolicy.tools.azure_devops_list_repositories.fields.project, {
    mode: "derived",
    required: true,
  });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(derivedProjectPolicy, "ado-project"));
});

test("frontend Work Item policy pins project context and preserves fixed Markdown descriptions", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_create_work_item.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.workItemType, { mode: "agent", required: true });
  assert.deepEqual(fields.title, { mode: "agent", required: true });
  assert.deepEqual(fields.description, { mode: "agent", required: false });
  assert.deepEqual(fields.parentId, { mode: "agent", required: false });
  for (const field of ["reproSteps", "systemInfo", "severity", "acceptanceCriteria"] as const) {
    assert.deepEqual(fields[field], { mode: "agent", required: false });
  }
  assert.doesNotThrow(() => assertRequiredWorkItemPolicy(defaultPolicy));

  const missingFixedValue = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_work_item: { fields: { workItemType: { mode: "fixed" } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemPolicy(missingFixedValue), /Work Item type 為必填/);

  const markdown = "# Description\n\n- preserve markers\n\n```ts\nconst value = 1\n```\n";
  const reproSteps = "## Repro Steps\n\n1. Start\n2. Reproduce\n";
  const systemInfo = "- Browser: Chromium\n- Version: 1.2.3\n";
  const acceptanceCriteria = "- [ ] Keep **Markdown** and line breaks\n";
  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_work_item: {
        fields: {
          project: { mode: "agent" },
          workItemType: { mode: "fixed", value: "Task" },
          title: { mode: "fixed", value: "Review deployment" },
          description: { mode: "fixed", value: markdown },
          parentId: { mode: "fixed", value: 74 },
          reproSteps: { mode: "fixed", value: reproSteps },
          systemInfo: { mode: "fixed", value: systemInfo },
          severity: { mode: "fixed", value: "2 - High" },
          acceptanceCriteria: { mode: "fixed", value: acceptanceCriteria },
        },
      },
    },
  }, "ado-project");

  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.project, {
    mode: "fixed",
    required: true,
    value: "ado-project",
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.workItemType, {
    mode: "fixed",
    required: true,
    value: "Task",
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.title, {
    mode: "fixed",
    required: true,
    value: "Review deployment",
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.description, {
    mode: "fixed",
    value: markdown,
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.parentId, {
    mode: "fixed",
    value: 74,
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.reproSteps, {
    mode: "fixed",
    value: reproSteps,
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.systemInfo, {
    mode: "fixed",
    value: systemInfo,
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.severity, {
    mode: "fixed",
    value: "2 - High",
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields.acceptanceCriteria, {
    mode: "fixed",
    value: acceptanceCriteria,
  });
  assert.doesNotThrow(() => assertRequiredWorkItemPolicy(fixedPolicy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));

  const invalidFixedParent = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_work_item: { fields: { parentId: { mode: "fixed", value: 0 } } } },
  }, "ado-project");
  assert.deepEqual(invalidFixedParent.tools.azure_devops_create_work_item.fields.parentId, { mode: "fixed" });
  assert.throws(() => assertAzureDevOpsParameterPolicy(invalidFixedParent, "ado-project"));
});

test("frontend Work Item update policy requires an ID while leaving changed fields optional", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_update_work_item.fields;

  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.workItemId, { mode: "agent", required: true });
  assert.deepEqual(fields.expectedRev, { mode: "agent", required: false });
  assert.deepEqual(fields.workItemType, { mode: "agent", required: false });
  assert.deepEqual(fields.title, { mode: "agent", required: false });
  assert.deepEqual(fields.state, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredWorkItemUpdatePolicy(defaultPolicy));

  const missingFixedId = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_update_work_item: { fields: { workItemId: { mode: "fixed" } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemUpdatePolicy(missingFixedId), /Work Item ID 為必填/);

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_update_work_item: {
        fields: {
          workItemId: { mode: "fixed", value: 74 },
          state: { mode: "fixed", value: "Active" },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_update_work_item.fields.workItemId, { mode: "fixed", required: true, value: 74 });
  assert.deepEqual(fixedPolicy.tools.azure_devops_update_work_item.fields.state, { mode: "fixed", value: "Active" });
  const callTimeRevision = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_update_work_item: {
        fields: {
          expectedRev: { mode: "agent" },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(callTimeRevision.tools.azure_devops_update_work_item.fields.expectedRev, { mode: "agent", required: false });
  const fixedRevisionAttempt = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_update_work_item: {
        fields: {
          expectedRev: { mode: "fixed", value: 12 },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedRevisionAttempt.tools.azure_devops_update_work_item.fields.expectedRev, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredWorkItemUpdatePolicy(fixedPolicy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));
});

test("frontend Work Item get policy requires a bounded ID and pins the selected Project", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_get_work_item.fields;

  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.workItemId, { mode: "agent", required: true });
  assert.doesNotThrow(() => assertRequiredWorkItemGetPolicy(defaultPolicy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(defaultPolicy, "ado-project"));

  const missingFixedId = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_get_work_item: { fields: { workItemId: { mode: "fixed" } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemGetPolicy(missingFixedId), /Work Item ID 為必填/);

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_get_work_item: {
        fields: {
          workItemId: { mode: "fixed", value: 74 },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_get_work_item.fields.workItemId, {
    mode: "fixed",
    required: true,
    value: 74,
  });
  assert.doesNotThrow(() => assertRequiredWorkItemGetPolicy(fixedPolicy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));

  const invalidFixedId = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_get_work_item: { fields: { workItemId: { mode: "fixed", value: 0 } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemGetPolicy(invalidFixedId), /Work Item ID 為必填/);
  assert.throws(() => assertAzureDevOpsParameterPolicy(invalidFixedId, "ado-project"));
});

test("frontend Work Item revision policy requires an ID and bounds fixed or Agent paging", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_list_work_item_revisions.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.workItemId, { mode: "agent", required: true });
  assert.deepEqual(fields.top, { mode: "agent", required: false });
  assert.deepEqual(fields.skip, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredWorkItemRevisionsPolicy(defaultPolicy));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(defaultPolicy, "ado-project"));

  const optionalID = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_list_work_item_revisions: { fields: { workItemId: { mode: "agent", required: false } } } },
  }, "ado-project");
  optionalID.tools.azure_devops_list_work_item_revisions.fields.workItemId = { mode: "agent", required: false };
  assert.throws(() => assertRequiredWorkItemRevisionsPolicy(optionalID), /Work Item ID 必須在每次呼叫中提供/);

  const fixedPaging = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_list_work_item_revisions: {
        fields: {
          workItemId: { mode: "fixed", value: 74 },
          top: { mode: "fixed", value: 20 },
          skip: { mode: "fixed", value: 0 },
        },
      },
    },
  }, "ado-project");
  assert.doesNotThrow(() => assertRequiredWorkItemRevisionsPolicy(fixedPaging));
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPaging, "ado-project"));

  const invalidTop = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_list_work_item_revisions: { fields: { top: { mode: "fixed", value: 21 } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemRevisionsPolicy(invalidTop), /Page size \(\$top\) 設為 fixed 時必須設定有效值/);
  assert.throws(() => assertAzureDevOpsParameterPolicy(invalidTop, "ado-project"));
  const invalidSkip = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_list_work_item_revisions: { fields: { skip: { mode: "fixed", value: -1 } } } },
  }, "ado-project");
  assert.throws(() => assertRequiredWorkItemRevisionsPolicy(invalidSkip), /Offset \(\$skip\) 設為 fixed 時必須設定有效值/);
  assert.throws(() => assertAzureDevOpsParameterPolicy(invalidSkip, "ado-project"));
});

test("frontend Pipeline YAML policy keeps Project fixed and requires Agent-supplied content on every call", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_publish_pipeline_yaml.fields;
  assert.deepEqual(fields.organization, { mode: "derived" });
  assert.deepEqual(fields.project, { mode: "fixed", required: true, value: "ado-project" });
  assert.deepEqual(fields.path, { mode: "agent", required: true });
  assert.deepEqual(fields.yamlContent, { mode: "agent", required: true });
  assert.deepEqual(fields.repositoryID, { mode: "agent", required: false });
  assert.doesNotThrow(() => assertRequiredPipelineYamlPolicy(defaultPolicy));

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_publish_pipeline_yaml: {
        fields: { path: { mode: "fixed", value: "pipelines/release.yml" } },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixedPolicy.tools.azure_devops_publish_pipeline_yaml.fields.path, {
    mode: "fixed",
    required: true,
    value: "pipelines/release.yml",
  });
  assert.deepEqual(fixedPolicy.tools.azure_devops_publish_pipeline_yaml.fields.yamlContent, { mode: "agent", required: true });
  assert.doesNotThrow(() => assertRequiredPipelineYamlPolicy(fixedPolicy));

  const legacyFixedContent = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_publish_pipeline_yaml: {
        fields: { yamlContent: { mode: "fixed", value: "legacy YAML must not be restored" } },
      },
    },
  }, "ado-project");
  assert.deepEqual(legacyFixedContent.tools.azure_devops_publish_pipeline_yaml.fields.yamlContent, { mode: "agent", required: true });
  assert.equal(JSON.stringify(legacyFixedContent).includes("legacy YAML must not be restored"), false);
  assert.deepEqual(compactParameterPolicy(legacyFixedContent, "ado-project"), { version: 1, tools: {} });

  const invalidFixedContent = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  invalidFixedContent.tools.azure_devops_publish_pipeline_yaml.fields.yamlContent = {
    mode: "fixed",
    value: "must not be saved",
  };
  assert.throws(() => assertRequiredPipelineYamlPolicy(invalidFixedContent), /不可設為 fixed/);

  const invalidPath = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_publish_pipeline_yaml: {
        fields: { path: { mode: "fixed", value: "../release.yml" } },
      },
    },
  }, "ado-project");
  assert.throws(() => assertRequiredPipelineYamlPolicy(invalidPath), /有效 fixed 值/);
});

test("frontend Work Item policy exposes and preserves each classification field", () => {
  const values: Record<string, string | number> = {
    areaPath: "Contoso\\Platform",
    iterationPath: "Contoso\\Sprint 1",
    assignedTo: "developer@example.com",
    priority: 3,
    tags: "agent-system; backend",
    state: "Active",
  };
  const defaultFields = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project")
    .tools.azure_devops_create_work_item.fields;
  for (const field of Object.keys(values)) assert.deepEqual(defaultFields[field], { mode: "agent", required: false });

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_work_item: {
        fields: Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { mode: "fixed", value }])),
      },
    },
  }, "ado-project");
  for (const [field, value] of Object.entries(values)) {
    assert.deepEqual(fixedPolicy.tools.azure_devops_create_work_item.fields[field], { mode: "fixed", value });
  }
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));
});

test("frontend Work Item policy persists decimal estimates and integer Business Value without truncation", () => {
  const defaultPolicy = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  const fields = defaultPolicy.tools.azure_devops_create_work_item.fields;
  for (const name of ["originalEstimate", "remainingWork", "completedWork", "storyPoints", "effort", "size", "businessValue", "activity"]) {
    assert.deepEqual(fields[name], { mode: "agent", required: false });
  }

  const fixedPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_create_work_item: {
        fields: {
          originalEstimate: { mode: "fixed", value: 1.25 },
          remainingWork: { mode: "fixed", value: 2.5 },
          completedWork: { mode: "fixed", value: 0.75 },
          activity: { mode: "fixed", value: "Development" },
          storyPoints: { mode: "fixed", value: 3.5 },
          effort: { mode: "fixed", value: 5.5 },
          size: { mode: "fixed", value: 8.25 },
          businessValue: { mode: "fixed", value: 0 },
        },
      },
    },
  }, "ado-project");

  assert.deepEqual(Object.fromEntries(Object.entries(fixedPolicy.tools.azure_devops_create_work_item.fields)
    .filter(([name]) => name in {
      originalEstimate: true,
      remainingWork: true,
      completedWork: true,
      activity: true,
      storyPoints: true,
      effort: true,
      size: true,
      businessValue: true,
    })), {
    originalEstimate: { mode: "fixed", value: 1.25 },
    remainingWork: { mode: "fixed", value: 2.5 },
    completedWork: { mode: "fixed", value: 0.75 },
    activity: { mode: "fixed", value: "Development" },
    storyPoints: { mode: "fixed", value: 3.5 },
    effort: { mode: "fixed", value: 5.5 },
    size: { mode: "fixed", value: 8.25 },
    businessValue: { mode: "fixed", value: 0 },
  });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixedPolicy, "ado-project"));

  const rejectedDecimal = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_work_item: { fields: { originalEstimate: { mode: "fixed", value: -0.5 } } } },
  }, "ado-project");
  assert.deepEqual(rejectedDecimal.tools.azure_devops_create_work_item.fields.originalEstimate, {
    mode: "fixed",
  });

  const rejectedFractionalBusinessValue = normalizeParameterPolicy({
    version: 1,
    tools: { azure_devops_create_work_item: { fields: { businessValue: { mode: "fixed", value: 1.5 } } } },
  }, "ado-project");
  assert.deepEqual(rejectedFractionalBusinessValue.tools.azure_devops_create_work_item.fields.businessValue, {
    mode: "fixed",
  });
  assert.throws(() => assertAzureDevOpsParameterPolicy(rejectedDecimal, "ado-project"));
  assert.throws(() => assertAzureDevOpsParameterPolicy(rejectedFractionalBusinessValue, "ado-project"));
});

test("frontend Wiki synchronization selects and preserves the Wiki ID for the current Project", () => {
  const wikis = normalizeWikis([
    { id: "code-wiki-id", name: "Engineering", type: "codeWiki" },
    { id: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", name: "AI_Traning_wiki", type: "projectWiki" },
    { id: "ignored", name: "" },
  ]);

  assert.deepEqual(wikis, [
    { id: "code-wiki-id", name: "Engineering", type: "codeWiki" },
    { id: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", name: "AI_Traning_wiki", type: "projectWiki" },
  ]);
  assert.equal(selectWikiIdentifier(wikis, "saved-valid-id"), "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f");
  assert.equal(selectWikiIdentifier(wikis, "code-wiki-id"), "code-wiki-id");
  assert.equal(selectWikiIdentifier([], "stale-project-wiki-id"), "");

  const withCreatedWiki = mergeWikis(wikis, [{
    id: "new-project-wiki-id",
    name: "New Wiki",
    type: "projectWiki",
  }]);
  assert.equal(withCreatedWiki.length, 3);
  assert.equal(selectWikiIdentifier(withCreatedWiki, "new-project-wiki-id"), "new-project-wiki-id");

  const policy = normalizeParameterPolicy({ version: 1, tools: {} }, "AI_Traning");
  assert.deepEqual(policy.tools.azure_devops_write_wiki_page.fields.wikiIdentifier, {
    mode: "derived",
    required: true,
  });
});

test("frontend Extension settings migration drops secret-shaped context fields", () => {
  assert.deepEqual(safeContextDocument({
    organization: "contoso",
    token: "pat-legacy",
    nested: { password: "secret" },
    credentialReference: "{env:EXTENSION_SECRET_KEY}",
  }), {
    organization: "contoso",
    nested: {},
  });
});

test("frontend Pipeline run policies expose bounded IDs, branch refs, and template parameters", () => {
  const defaults = normalizeParameterPolicy({ version: 1, tools: {} }, "ado-project");
  assert.deepEqual(defaults.tools.azure_devops_preview_pipeline.fields.organization, { mode: "derived" });
  assert.deepEqual(defaults.tools.azure_devops_preview_pipeline.fields.project, {
    mode: "fixed",
    required: true,
    value: "ado-project",
  });
  assert.deepEqual(defaults.tools.azure_devops_preview_pipeline.fields.pipelineId, { mode: "agent", required: true });
  assert.deepEqual(defaults.tools.azure_devops_run_pipeline.fields.branchRef, { mode: "agent", required: false });
  assert.deepEqual(defaults.tools.azure_devops_get_pipeline_run.fields.runId, { mode: "agent", required: true });

  const fixed = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_run_pipeline: {
        fields: {
          templateParameters: { mode: "fixed", value: { environment: "staging", deploy: true } },
        },
      },
    },
  }, "ado-project");
  assert.deepEqual(fixed.tools.azure_devops_run_pipeline.fields.templateParameters, {
    mode: "fixed",
    value: { environment: "staging", deploy: true },
  });
  assert.doesNotThrow(() => assertAzureDevOpsParameterPolicy(fixed, "ado-project"));
});

test("frontend bounds template parameter JSON while BFF policy owns semantic validation", () => {
  const templateParameters = { password: "never-persist", nested: { key: "not-a-scalar" } };
  const frontendPolicy = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_run_pipeline: {
        fields: { templateParameters: { mode: "fixed", value: templateParameters } },
      },
    },
  }, "ado-project");

  assert.deepEqual(frontendPolicy.tools.azure_devops_run_pipeline.fields.templateParameters, {
    mode: "fixed",
    value: templateParameters,
  });
  assert.throws(
    () => assertAzureDevOpsParameterPolicy(frontendPolicy, "ado-project"),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "AZURE_DEVOPS_POLICY_INVALID",
  );

  const oversized = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_run_pipeline: {
        fields: { templateParameters: { mode: "fixed", value: { payload: "x".repeat(10_001) } } },
      },
    },
  }, "ado-project");
  assert.equal(Object.prototype.hasOwnProperty.call(oversized.tools.azure_devops_run_pipeline.fields.templateParameters, "value"), false);
});

test("frontend keeps template JSON object and size checks while core BFF policy validates parameter semantics", () => {
  for (const templateParameters of [
    { password: "not-stored" },
    { nested: { key: "not-a-scalar" } },
  ]) {
    const frontendPolicy = normalizeParameterPolicy({
      version: 1,
      tools: {
        azure_devops_run_pipeline: {
          fields: { templateParameters: { mode: "fixed", value: templateParameters } },
        },
      },
    }, "ado-project");
    assert.deepEqual(frontendPolicy.tools.azure_devops_run_pipeline.fields.templateParameters, {
      mode: "fixed",
      value: templateParameters,
    });
    assert.throws(
      () => assertAzureDevOpsParameterPolicy(frontendPolicy, "ado-project"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "AZURE_DEVOPS_POLICY_INVALID",
    );
  }

  const oversized = normalizeParameterPolicy({
    version: 1,
    tools: {
      azure_devops_run_pipeline: {
        fields: { templateParameters: { mode: "fixed", value: { payload: "x".repeat(10_001) } } },
      },
    },
  }, "ado-project");
  assert.equal(Object.prototype.hasOwnProperty.call(oversized.tools.azure_devops_run_pipeline.fields.templateParameters, "value"), false);
});
