import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { currentWorktree } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/agent/context.ts";
import { getCachedAzureDevOpsCredential } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/tools/credential-cache.ts";
import * as AzureDevOpsPlatformModule from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform.js";
import AzureDevOpsV2Plugin from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform.js";
import {
  azureDevOpsPlatformTestSeams,
  createAzureDevOpsToolDefinitions,
} from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import { jsonSchemaAccepts } from "./helpers/json-schema.ts";
import {
  callRepositoryBackend,
  readPullPlanResponse,
  readPullResponse,
  readPushResponse,
} from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/backend-client/client.ts";
import {
  resolveAzureDevOpsConfigureRemoteTarget,
  resolveAzureDevOpsPushRepositoryPath,
  resolveAzureDevOpsRepositoryPath,
} from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/tools/repository-path.ts";
import { readAzureDevOpsWorkItemDetailsResponse } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/tools/work-item-details.ts";

const {
  agentParameters: AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS,
  cloneAzureDevOpsRepository,
  configureAzureDevOpsRemote,
  createAzureDevOpsGitProcess,
  createAzureDevOpsGitOperations,
  pullAzureDevOpsWorktree,
  pushAzureDevOpsWorktree,
  toOpenCodeToolResult,
  validateAzureDevOpsRemoteUrl,
} = azureDevOpsPlatformTestSeams;

const execFile = promisify(execFileCallback);
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const CANONICAL_REMOTE = "https://dev.azure.com/contoso/ado-project/_git/repository";
const ORGANIZATION_QUALIFIED_REMOTE = "https://contoso@dev.azure.com/contoso/ado-project/_git/repository";
type AzureDevOpsRepositoryMetadata = {
  id: string;
  name: string;
  project: { id: string; name: string };
  remoteUrl: string;
  repositoryReference: string;
};
const metadata: AzureDevOpsRepositoryMetadata = {
  id: REPOSITORY_ID,
  name: "repository",
  project: { id: "22222222-2222-4222-8222-222222222222", name: "ado-project" },
  remoteUrl: CANONICAL_REMOTE,
  repositoryReference: `azure-devops://contoso/ado-project/${REPOSITORY_ID}`,
};
const EXTENSION_SECRET = "extension-secret-value";

test("Azure DevOps Plugin registers its catalog through the OpenCode V2 Plugin API without network calls", async () => {
  const originalFetch = globalThis.fetch;
  const registeredTools = new Map<string, Record<string, unknown>>();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Plugin setup must not call the Azure DevOps backend.");
  };
  try {
    const registeredSkills = new Map<string, Record<string, unknown>>();
    await AzureDevOpsV2Plugin.setup({
      location: { directory: "/workspace/projects/demo" },
      tool: {
        transform: async (transform: (editor: { add(tool: Record<string, unknown>): void }) => void) => {
          transform({ add: (tool) => registeredTools.set(String(tool.name), tool) });
        },
      },
      skill: {
        transform: async (transform: (editor: { add(skill: Record<string, unknown>): void }) => void) => {
          transform({ add: (skill) => registeredSkills.set(String(skill.id), skill) });
        },
      },
    } as never);

    const manifest = JSON.parse(await readFile(new URL("../extension-packages/azure-devops-platform/extension.json", import.meta.url), "utf8")) as {
      pluginContributions: Array<{ pluginName: string; contributions: Array<{ kind: string; name: string }> }>;
    };
    const expectedToolNames = manifest.pluginContributions
      .find((contribution) => contribution.pluginName === "azure-devops-platform")!
      .contributions
      .filter((contribution) => contribution.kind === "tool")
      .map((contribution) => contribution.name)
      .sort();

    assert.equal(AzureDevOpsV2Plugin.id, "azure-devops-platform");
    assert.deepEqual([...registeredTools.keys()].sort(), expectedToolNames);
    assert.equal([...registeredTools.values()].every((tool) => (tool.options as { codemode?: boolean }).codemode === false), true);
    assert.deepEqual([...registeredSkills.values()].map((skill) => skill.name), ["Minimal API Service Cloud Run Pipeline"]);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the project directory when OpenCode reports a non-repository filesystem root as its worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "azure-devops-current-project-directory-"));
  try {
    assert.equal(currentWorktree(
      { directory, worktree: "/" },
      { directory, worktree: "/" },
    ), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps the current Git worktree root when the project directory is nested inside it", async () => {
  await withGitWorktree(async (worktree) => {
    const directory = join(worktree, "nested");
    await mkdir(directory);

    assert.equal(currentWorktree(
      { directory, worktree },
      { directory, worktree },
    ), worktree);
  });
});

test("resolves Azure DevOps push paths only to cloned repositories under the current Project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "azure-devops-push-project-"));
  const repositoryRoot = join(projectRoot, "repository");
  const repositoryPath = join(repositoryRoot, "selected-repository");
  const outsideRepository = join(projectRoot, "outside-repository");
  try {
    await mkdir(repositoryRoot);
    await mkdir(repositoryPath);
    await git(repositoryPath, ["init"]);
    assert.equal(
      await resolveAzureDevOpsPushRepositoryPath(projectRoot, "repository/selected-repository"),
      repositoryPath,
    );
    assert.equal(
      await resolveAzureDevOpsRepositoryPath(projectRoot, "repository/selected-repository"),
      repositoryPath,
    );

    await assert.rejects(
      () => resolveAzureDevOpsPushRepositoryPath(projectRoot, "repository/../outside-repository"),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REPOSITORY_PATH_INVALID",
    );
    await assert.rejects(
      () => resolveAzureDevOpsPushRepositoryPath(projectRoot, "repository/not-a-repository"),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REPOSITORY_PATH_INVALID",
    );

    await mkdir(outsideRepository);
    await git(outsideRepository, ["init"]);
    await symlink(outsideRepository, join(repositoryRoot, "linked-repository"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => resolveAzureDevOpsPushRepositoryPath(projectRoot, "repository/linked-repository"),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REPOSITORY_PATH_INVALID",
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("requires repositoryPath instead of falling back to a non-Git project root without a name match", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "azure-devops-configure-remote-missing-checkout-"));
  try {
    await assert.rejects(
      () => resolveAzureDevOpsConfigureRemoteTarget(projectRoot, undefined, "solo-block-stacker"),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_PATH_REQUIRED",
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("exports only the OpenCode V2 Plugin entrypoint", () => {
  assert.equal(AzureDevOpsV2Plugin.id, "azure-devops-platform");
  assert.equal(typeof AzureDevOpsV2Plugin.setup, "function");
  assert.deepEqual(Object.keys(AzureDevOpsPlatformModule), ["default"]);
});

test("registers the bundled Skill through the Azure DevOps Plugin directory", async () => {
  const registeredSkills: Record<string, unknown>[] = [];
  await AzureDevOpsV2Plugin.setup({
    location: { directory: "/workspace/projects/demo" },
    tool: { transform: async () => undefined },
    skill: {
      transform: async (transform: (editor: { add(skill: Record<string, unknown>): void }) => void) => {
        transform({ add: (skill) => registeredSkills.push(skill) });
      },
    },
  } as never);

  assert.equal(registeredSkills.length, 1);
  assert.equal(registeredSkills[0]?.id, "minimal-api-service-cloud-run-pipeline");
  assert.equal(registeredSkills[0]?.path, join(dirname(fileURLToPath(new URL("../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts", import.meta.url))), "skills", "minimal-api-service-cloud-run-pipeline", "SKILL.md"));
  assert.match(String(registeredSkills[0]?.content), /Azure DevOps/);
});

test("registers Wiki tools and routes them through the project-scoped Extension backend", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ body, path: endpoint.pathname, project: endpoint.searchParams.get("project") ?? undefined });
    if (endpoint.pathname.endsWith("/list-wikis")) {
      return new Response(JSON.stringify({
        count: 1,
        truncated: false,
        wikis: [{ id: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", name: "Project Wiki", type: "projectWiki" }],
      }), { headers: { "content-type": "application/json" }, status: 200 });
    }
    return new Response(JSON.stringify({
      created: false,
      createdAncestors: ["/PRD", "/PRD/xxx"],
      wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f",
      wikiName: "Project Wiki",
      path: "/Guides/Setup",
      page: { id: 12, path: "/Guides/Setup", remoteUrl: "https://dev.azure.com/contoso/project/_wiki/" },
      etag: "new-etag",
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
    assert.ok(runtime.azure_devops_list_wikis);
    assert.ok(runtime.azure_devops_write_wiki_page);

    const listResult = await runtime.azure_devops_list_wikis.execute({}, { metadata: async () => undefined });
    const listOutput = JSON.parse(listResult.content) as { wikis: Array<{ id: string; name: string }> };
    assert.deepEqual(listOutput.wikis, [{ id: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", name: "Project Wiki", type: "projectWiki" }]);

    const markdown = "# Setup\n\nFirst paragraph.\n";
    const writeResult = await runtime.azure_devops_write_wiki_page.execute({
      wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f",
      path: "/Guides/Setup",
      content: markdown,
    }, { metadata: async () => undefined });
    assert.deepEqual(JSON.parse(writeResult.content), {
      created: false,
      createdAncestors: ["/PRD", "/PRD/xxx"],
      wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f",
      wikiName: "Project Wiki",
      path: "/Guides/Setup",
      page: { id: 12, path: "/Guides/Setup", remoteUrl: "https://dev.azure.com/contoso/project/_wiki/" },
      etag: "new-etag",
    });
    assert.deepEqual(requests.map(({ path, project }) => ({ path: path.split("/").at(-1), project })), [
      { path: "list-wikis", project: "managed-project" },
      { path: "write-wiki-page", project: "managed-project" },
    ]);
    assert.deepEqual(requests[1]?.body, {
      tool: "azure_devops_write_wiki_page",
      agentInput: { wikiIdentifier: "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f", path: "/Guides/Setup", content: markdown },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registers the repository-list Tool and sends only its policy-controlled Project input to BFF", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      path: endpoint.pathname,
      project: endpoint.searchParams.get("project") ?? undefined,
    });
    return new Response(JSON.stringify({
      count: 1,
      repositories: [{
        id: REPOSITORY_ID,
        name: "repository",
        remoteUrl: CANONICAL_REMOTE,
        project: { id: "must-not-be-forwarded", name: "must-not-be-forwarded" },
        authorization: "must-not-be-forwarded",
      }],
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = await createAzureDevOpsToolDefinitions({ project: "managed-project" } as never) as unknown as Record<string, any>;
    const listRepositories = runtime.azure_devops_list_repositories;
    assert.ok(listRepositories);
    assert.deepEqual(Object.keys(listRepositories.input.properties), ["project"]);

    const result = await listRepositories.execute({ project: "ado-project" }, { metadata: async () => undefined });
    assert.deepEqual(JSON.parse(result.content), {
      count: 1,
      repositories: [{ id: REPOSITORY_ID, name: "repository", remoteUrl: CANONICAL_REMOTE }],
    });
    assert.deepEqual(requests, [{
      body: { tool: "azure_devops_list_repositories", agentInput: { project: "ado-project" } },
      path: "/bff/extensions/azure-devops-platform/backend/list-repositories",
      project: "managed-project",
    }]);
    assert.equal(result.content.includes("must-not-be-forwarded"), false);
    assert.equal(result.content.includes("pat-secret-value"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("propagates the bounded BFF failure through the repository-list Tool", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ path: string; project?: string }> = [];
  globalThis.fetch = async (input) => {
    const endpoint = new URL(String(input));
    requests.push({
      path: endpoint.pathname,
      project: endpoint.searchParams.get("project") ?? undefined,
    });
    return new Response(JSON.stringify({
      error: {
        code: "ADO_REPOSITORY_LIST_FAILED",
        message: "Azure DevOps repositories could not be loaded (HTTP 403).",
        details: { upstreamStatus: 403 },
      },
    }), { headers: { "content-type": "application/json" }, status: 502 });
  };

  try {
    const runtime = await createAzureDevOpsToolDefinitions({ project: "managed-project" } as never) as unknown as Record<string, any>;
    const listRepositories = runtime.azure_devops_list_repositories;
    assert.ok(listRepositories);

    await assert.rejects(
      () => listRepositories.execute({ project: "ado-project" }, { metadata: async () => undefined }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const failure = error as Error & { code?: string; details?: Record<string, unknown> };
        assert.equal(failure.code, "ADO_REPOSITORY_LIST_FAILED");
        assert.match(failure.message, /HTTP 502/);
        assert.match(failure.message, /Azure DevOps HTTP 403/);
        assert.equal(failure.message.length <= 2_000, true);
        assert.deepEqual(failure.details, { httpStatus: 502, upstreamStatus: 403 });
        assert.equal(failure.message.includes("pat-secret-value"), false);
        assert.equal(failure.message.includes(EXTENSION_SECRET), false);
        return true;
      },
    );
    assert.deepEqual(requests, [{
      path: "/bff/extensions/azure-devops-platform/backend/list-repositories",
      project: "managed-project",
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registers the Work Item read Tool with a bounded schema and allowlisted result projection", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      path: endpoint.pathname,
      project: endpoint.searchParams.get("project") ?? undefined,
    });
    return new Response(JSON.stringify({
      id: 74,
      rev: 9,
      type: "Bug",
      title: "Read a Work Item",
      state: "Resolved",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      description: "# Preserve Markdown\n",
      assignedTo: { displayName: "Ada", uniqueName: "ada@example.com", id: "private" },
      changedBy: { displayName: "Grace", uniqueName: "grace@example.com", descriptor: "private" },
      changedDate: "2026-10-05T12:34:56Z",
      relations: [{ url: "https://private.example/relation" }],
      authorization: "must-not-escape",
      customField: "must-not-escape",
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = await createAzureDevOpsToolDefinitions({ project: "managed-project" } as never) as unknown as Record<string, any>;
    const getWorkItem = runtime.azure_devops_get_work_item;
    assert.ok(getWorkItem);
    assert.deepEqual(Object.keys(getWorkItem.input.properties), ["project", "workItemId"]);
    assert.equal(getWorkItem.input.required?.includes("project"), false);
    assert.equal(getWorkItem.input.required?.includes("workItemId"), false);
    const workItemIdSchema = getWorkItem.input.properties.workItemId;
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 1), true);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 2_147_483_647), true);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 0), false);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 1.5), false);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 2_147_483_648), false);

    const result = await getWorkItem.execute({ workItemId: 74 }, { metadata: async () => undefined });
    assert.deepEqual(JSON.parse(result.content), {
      id: 74,
      rev: 9,
      type: "Bug",
      title: "Read a Work Item",
      state: "Resolved",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      description: "# Preserve Markdown\n",
      assignedTo: { displayName: "Ada", uniqueName: "ada@example.com" },
    });
    assert.deepEqual(requests, [{
      body: { tool: "azure_devops_get_work_item", agentInput: { workItemId: 74 } },
      path: "/bff/extensions/azure-devops-platform/backend/get-work-item",
      project: "managed-project",
    }]);
    assert.equal(result.content.includes("private.example"), false);
    assert.equal(result.content.includes("must-not-escape"), false);
    assert.equal(result.content.includes(EXTENSION_SECRET), false);

    assert.throws(
      () => readAzureDevOpsWorkItemDetailsResponse({
        id: 74,
        rev: 1,
        type: "Task",
        title: "Malformed",
        state: "Active",
        url: "https://untrusted.example/workItems/74",
      }),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_WORK_ITEM_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registers the Work Item Tool and forwards only the policy-controlled fields", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      path: endpoint.pathname,
      project: endpoint.searchParams.get("project") ?? undefined,
    });
    return new Response(JSON.stringify({
      id: 74,
      rev: 1,
      type: "Bug",
      title: "Markdown description",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      fields: { "System.Description": "must-not-be-returned" },
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
    const createWorkItem = runtime.azure_devops_create_work_item;
    assert.ok(createWorkItem);
    assert.deepEqual(Object.keys(createWorkItem.input.properties), [
      "project",
      "workItemType",
      "title",
      "description",
      "parentId",
      "areaPath",
      "iterationPath",
      "assignedTo",
      "priority",
      "tags",
      "state",
      "reproSteps",
      "systemInfo",
      "severity",
      "acceptanceCriteria",
      "originalEstimate",
      "remainingWork",
      "completedWork",
      "activity",
      "storyPoints",
      "effort",
      "size",
      "businessValue",
    ]);
    const prioritySchema = createWorkItem.input.properties.priority as Record<string, unknown>;
    assert.equal(createWorkItem.input.required?.includes("priority"), false);
    assert.match(String(prioritySchema.description), /integer Work Item priority/);
    const parentIdSchema = createWorkItem.input.properties.parentId;
    assert.equal(createWorkItem.input.required?.includes("parentId"), false);
    assert.equal(jsonSchemaAccepts(parentIdSchema, 74), true);
    assert.equal(jsonSchemaAccepts(parentIdSchema, 2_147_483_647), true);
    assert.equal(jsonSchemaAccepts(parentIdSchema, 0), false);
    assert.equal(jsonSchemaAccepts(parentIdSchema, 1.5), false);
    assert.equal(jsonSchemaAccepts(parentIdSchema, 2_147_483_648), false);
    const markdown = "# Background\n\n- keep this raw\n";
    const agentInput = {
      workItemType: "Bug",
      title: "Markdown description",
      description: markdown,
      parentId: 74,
      areaPath: "Contoso\\Platform",
      iterationPath: "Contoso\\Sprint 1",
      assignedTo: "developer@example.com",
      priority: 2,
      tags: "agent-system; backend",
      state: "Active",
      reproSteps: "## Repro\n\n1. Submit the form\n",
      systemInfo: "- Browser: Chromium\n",
      severity: "2 - High",
      acceptanceCriteria: "- [ ] Preserve rich-text input\n",
      originalEstimate: 1.25,
      remainingWork: 2.5,
      completedWork: 0.75,
      activity: "Development",
      storyPoints: 3.5,
      effort: 5.5,
      size: 8.25,
      businessValue: 100,
    };
    const result = await createWorkItem.execute(agentInput, {
      metadata: async () => undefined,
    });

    assert.deepEqual(JSON.parse(result.content), {
      id: 74,
      rev: 1,
      type: "Bug",
      title: "Markdown description",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
    });
    assert.deepEqual(requests.map(({ path, project }) => ({ path: path.split("/").at(-1), project })), [
      { path: "create-work-item", project: "managed-project" },
    ]);
    assert.deepEqual(requests[0]?.body, {
      tool: "azure_devops_create_work_item",
      agentInput,
    });
    assert.equal(result.content.includes("must-not-be-returned"), false);
    assert.equal(result.content.includes("pat-secret-value"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registers the Work Item update Tool and forwards only its policy-controlled partial fields", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      path: endpoint.pathname,
      project: endpoint.searchParams.get("project") ?? undefined,
    });
    return new Response(JSON.stringify({
      id: 74,
      rev: 8,
      type: "Task",
      title: "Existing title",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
    const updateWorkItem = runtime.azure_devops_update_work_item;
    assert.ok(updateWorkItem);
    assert.deepEqual(Object.keys(updateWorkItem.input.properties), [
      "project",
      "workItemId",
      "expectedRev",
      "workItemType",
      "title",
      "description",
      "areaPath",
      "iterationPath",
      "assignedTo",
      "priority",
      "tags",
      "state",
      "reproSteps",
      "systemInfo",
      "severity",
      "acceptanceCriteria",
      "originalEstimate",
      "remainingWork",
      "completedWork",
      "activity",
      "storyPoints",
      "effort",
      "size",
      "businessValue",
    ]);
    const workItemIdSchema = updateWorkItem.input.properties.workItemId;
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 1), true);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 2_147_483_647), true);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 0), false);
    assert.equal(jsonSchemaAccepts(workItemIdSchema, 2_147_483_648), false);
    const expectedRevSchema = updateWorkItem.input.properties.expectedRev;
    assert.equal(updateWorkItem.input.required?.includes("expectedRev"), false);
    assert.equal(jsonSchemaAccepts(expectedRevSchema, 1), true);
    assert.equal(jsonSchemaAccepts(expectedRevSchema, 2_147_483_647), true);
    assert.equal(jsonSchemaAccepts(expectedRevSchema, 0), false);
    assert.equal(jsonSchemaAccepts(expectedRevSchema, 1.5), false);
    assert.equal(jsonSchemaAccepts(expectedRevSchema, 2_147_483_648), false);
    assert.match(updateWorkItem.description ?? "", /azure_devops_get_work_item/);
    assert.match(updateWorkItem.description ?? "", /never automatically retry or replay the patch/);

    const result = await updateWorkItem.execute({ workItemId: 74, expectedRev: 7, state: "Active" }, { metadata: async () => undefined });
    assert.deepEqual(JSON.parse(result.content), {
      id: 74,
      rev: 8,
      type: "Task",
      title: "Existing title",
      url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
    });
    assert.deepEqual(requests, [{
      path: "/bff/extensions/azure-devops-platform/backend/update-work-item",
      project: "managed-project",
      body: {
        tool: "azure_devops_update_work_item",
        agentInput: { workItemId: 74, expectedRev: 7, state: "Active" },
      },
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("formats successful repository tool results using the OpenCode ToolResult contract", () => {
  const value = { cloned: true, destination: "repository/AI_Traning", remoteName: "origin" };
  assert.deepEqual(toOpenCodeToolResult("Azure DevOps repository cloned", value), {
    content: JSON.stringify(value, null, 2),
    metadata: { title: "Azure DevOps repository cloned" },
  });
});

test("configures local Git identity and caches the brokered ADO PAT in memory until expiry", async () => {
  await withGitWorktree(async (worktree) => {
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    await git(worktree, ["remote", "add", "origin", CANONICAL_REMOTE]);
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
    process.env.XDG_CACHE_HOME = join(worktree, "xdg-cache");
    globalThis.fetch = async (input) => {
      assert.equal(new URL(String(input)).pathname, "/bff/extensions/azure-devops-platform/backend/get-git-credential");
      return new Response(JSON.stringify({
        credential: "pat-secret-value",
        organization: "contoso",
        project: "ado-project",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ directory: worktree, project: "managed-project" } as never);
      const result = await plugin.azure_devops_git_config.execute({}, { worktree } as never) as { content: string };
      const output = JSON.parse(result.content) as {
        credentialCache: { cached: boolean; expiresAt: string };
        credentialHelper: { configured: boolean; remoteCount: number };
        user: { email: string; name: string };
      };

      assert.deepEqual(output.user, { email: "opencode@double-cash.com", name: "opencode" });
      assert.equal(output.credentialCache.cached, true);
      assert.deepEqual(output.credentialHelper, { configured: true, remoteCount: 1 });
      assert.equal(await gitConfig(worktree, "user.name"), "opencode");
      assert.equal(await gitConfig(worktree, "user.email"), "opencode@double-cash.com");
      assert.equal(await gitConfig(worktree, "credential.helper"), "cache --timeout=900");
      assert.equal(await gitConfig(worktree, "credential.useHttpPath"), "true");
      assert.equal(result.content.includes("pat-secret-value"), false);
      assert.equal((await readFile(join(worktree, ".git", "config"), "utf8")).includes("pat-secret-value"), false);

      const resolvedCredential = execFileSync("git", ["credential", "fill"], {
        cwd: worktree,
        encoding: "utf8",
        input: "protocol=https\nhost=dev.azure.com\npath=contoso/ado-project/_git/repository\nusername=azure-devops\n\n",
        windowsHide: true,
      });
      assert.match(resolvedCredential, /password=pat-secret-value/);

      const expiresAt = Date.parse(output.credentialCache.expiresAt);
      assert.ok(expiresAt > Date.now());
      assert.deepEqual(getCachedAzureDevOpsCredential("contoso", "ado-project"), {
        credential: "pat-secret-value",
        expiresAt,
      });
      assert.equal(getCachedAzureDevOpsCredential("contoso", "ado-project", expiresAt), undefined);
    } finally {
      await git(worktree, ["credential-cache", "exit"]).catch(() => "");
      globalThis.fetch = previousFetch;
      restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
      restoreEnvironment("XDG_CACHE_HOME", previousXdgCacheHome);
    }
  });
});

test("reuses shared project, repository identity, and remote parameters across tools", async () => {
  const tools = createAzureDevOpsToolDefinitions({});

  assert.equal(tools.azure_devops_create_repository.input.properties.project, tools.azure_devops_configure_remote.input.properties.project);
  assert.equal(tools.azure_devops_create_repository.input.properties.project, tools.azure_devops_push.input.properties.project);
  assert.equal(tools.azure_devops_create_repository.input.properties.project, tools.azure_devops_git_pull.input.properties.project);
  assert.equal(tools.azure_devops_create_repository.input.properties.project, tools.azure_devops_clone_repository.input.properties.project);
  assert.equal(tools.azure_devops_create_repository.input.properties.repositoryName, tools.azure_devops_configure_remote.input.properties.repositoryName);
  assert.equal(tools.azure_devops_configure_remote.input.properties.repositoryName, tools.azure_devops_clone_repository.input.properties.repositoryName);
  assert.equal(tools.azure_devops_configure_remote.input.properties.repositoryReference, tools.azure_devops_clone_repository.input.properties.repositoryReference);
  assert.equal(tools.azure_devops_configure_remote.input.properties.repositoryID, tools.azure_devops_clone_repository.input.properties.repositoryID);
  assert.equal(tools.azure_devops_configure_remote.input.properties.remoteName, tools.azure_devops_push.input.properties.remoteName);
  assert.equal(tools.azure_devops_configure_remote.input.properties.remoteName, tools.azure_devops_git_pull.input.properties.remoteName);
  assert.ok(tools.azure_devops_configure_remote.input.properties.repositoryPath);
  const configureRepositoryPathSchema = tools.azure_devops_configure_remote.input.properties.repositoryPath as Record<string, unknown>;
  assert.equal(tools.azure_devops_configure_remote.input.required?.includes("repositoryPath"), false);
  assert.match(String(configureRepositoryPathSchema.description), /nested checkout/);
  assert.ok(tools.azure_devops_push.input.properties.repositoryPath);
  assert.equal(tools.azure_devops_push.input.required?.includes("repositoryPath"), true);
  assert.match(String((tools.azure_devops_push.input.properties.repositoryPath as { description?: unknown }).description), /Required for every push/);
  assert.ok(tools.azure_devops_git_pull.input.properties.repositoryPath);
  const pullRepositoryPathSchema = tools.azure_devops_git_pull.input.properties.repositoryPath as Record<string, unknown>;
  assert.equal(tools.azure_devops_git_pull.input.required?.includes("repositoryPath"), true);
  assert.match(String(pullRepositoryPathSchema.description), /Required for every pull/);
  assert.equal(tools.azure_devops_git_pull.input.required?.includes("branch"), false);
});

test("configures the default origin from resolved canonical metadata without credentials", async () => {
  await withGitWorktree(async (worktree) => {
    const result = await configureAzureDevOpsRemote(
      { repositoryReference: metadata.repositoryReference },
      { git: createAzureDevOpsGitOperations(), resolveRepository: async () => metadata, worktree },
    );

    assert.equal(result.remoteName, "origin");
    assert.equal(result.changed, true);
    assert.equal((await gitConfig(worktree, "remote.origin.url")), CANONICAL_REMOTE);
    assert.equal(JSON.stringify(result).includes("pat-secret-value"), false);
    assert.equal((await readFile(join(worktree, ".git", "config"), "utf8")).includes("pat-secret-value"), false);
  });
});

test("canonicalizes the Azure DevOps organization-qualified HTTPS URL before configuring a remote", async () => {
  await withGitWorktree(async (worktree) => {
    const result = await configureAzureDevOpsRemote(
      { repositoryReference: metadata.repositoryReference },
      {
        git: createAzureDevOpsGitOperations(),
        resolveRepository: async () => ({ ...metadata, remoteUrl: ORGANIZATION_QUALIFIED_REMOTE }),
        worktree,
      },
    );

    assert.equal(result.remoteUrl, CANONICAL_REMOTE);
    assert.equal(await gitConfig(worktree, "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("refuses an existing remote by default and preserves its URL", async () => {
  await withGitWorktree(async (worktree) => {
    await git(worktree, ["remote", "add", "origin", "https://dev.azure.com/contoso/ado-project/_git/old"]);

    await assert.rejects(
      configureAzureDevOpsRemote(
        { repositoryID: REPOSITORY_ID },
        { git: createAzureDevOpsGitOperations(), resolveRepository: async () => metadata, worktree },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REMOTE_CONFLICT",
    );
    assert.equal(await gitConfig(worktree, "remote.origin.url"), "https://dev.azure.com/contoso/ado-project/_git/old");
  });
});

test("updates an existing remote only with explicit mutation confirmation", async () => {
  await withGitWorktree(async (worktree) => {
    await git(worktree, ["remote", "add", "origin", "https://dev.azure.com/contoso/ado-project/_git/old"]);

    const result = await configureAzureDevOpsRemote(
      { repositoryID: REPOSITORY_ID, updateExisting: true },
      { git: createAzureDevOpsGitOperations(), resolveRepository: async () => metadata, worktree },
    );

    assert.equal(result.changed, true);
    assert.equal(await gitConfig(worktree, "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("treats an already-canonical remote as an idempotent configuration", async () => {
  await withGitWorktree(async (worktree) => {
    await git(worktree, ["remote", "add", "origin", CANONICAL_REMOTE]);

    const result = await configureAzureDevOpsRemote(
      { repositoryID: REPOSITORY_ID, repositoryPath: "repository/solo-block-stacker" },
      { git: createAzureDevOpsGitOperations(), resolveRepository: async () => metadata, worktree },
    );

    assert.equal(result.changed, false);
    assert.equal(result.repositoryPath, "repository/solo-block-stacker");
    assert.equal(await gitConfig(worktree, "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("rejects arbitrary remote URLs returned as repository metadata before Git mutation", async () => {
  await withGitWorktree(async (worktree) => {
    const attackerMetadata = { ...metadata, remoteUrl: "https://attacker.example/repository.git" };
    await assert.rejects(
      configureAzureDevOpsRemote(
        { repositoryName: "repository" },
        { git: createAzureDevOpsGitOperations(), resolveRepository: async () => attackerMetadata, worktree },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_INVALID",
    );
    await assert.rejects(() => gitConfig(worktree, "remote.origin.url"));
  });
});

test("rejects repository metadata whose remote identifies a different repository", async () => {
  await withGitWorktree(async (worktree) => {
    await assert.rejects(
      configureAzureDevOpsRemote(
        { repositoryReference: metadata.repositoryReference },
        {
          git: createAzureDevOpsGitOperations(),
          resolveRepository: async () => ({
            ...metadata,
            remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository",
          }),
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_INVALID",
    );
    await assert.rejects(() => gitConfig(worktree, "remote.origin.url"));
  });
});

test("exposes only allowed repository tool inputs and never accepts remoteUrl", () => {
  assert.deepEqual(Object.keys(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS), [
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
    "azure_devops_list_wikis",
    "azure_devops_write_wiki_page",
    "azure_devops_create_work_item",
    "azure_devops_get_work_item",
    "azure_devops_list_work_item_revisions",
    "azure_devops_update_work_item",
    "azure_devops_publish_pipeline_yaml",
    "azure_devops_preview_pipeline",
    "azure_devops_run_pipeline",
    "azure_devops_get_pipeline_run",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_create_repository, ["project", "repositoryName"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_configure_remote, [
    "project",
    "repositoryReference",
    "repositoryID",
    "repositoryName",
    "repositoryPath",
    "remoteName",
    "updateExisting",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_clone_repository, [
    "project",
    "repositoryReference",
    "repositoryID",
    "repositoryName",
    "branch",
    "ref",
    "depth",
    "destination",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_list_repositories, ["project"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_list_pipelines, ["project", "continuationToken"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_create_pipeline, [
    "project",
    "repositoryReference",
    "repositoryID",
    "repositoryName",
    "name",
    "yamlPath",
    "folder",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_create_pull_request, [
    "project",
    "repositoryReference",
    "repositoryID",
    "repositoryName",
    "sourceRefName",
    "targetRefName",
    "title",
    "description",
    "isDraft",
    "reviewerIds",
    "workItemIds",
    "labels",
    "supportsIterations",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_get_pull_request, [
    "project",
    "pullRequestId",
    "commitTop",
    "commitContinuationToken",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_list_pull_requests, [
    "project",
    "repositoryReference",
    "repositoryID",
    "repositoryName",
    "sourceRefName",
    "targetRefName",
    "status",
    "top",
    "skip",
  ]);
  assert.equal(Object.values(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS).flat().includes("remoteUrl"), false);
  assert.equal(Object.values(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS).flat().includes("credential"), false);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_push, ["project", "repositoryPath", "remoteName", "branch", "setUpstream"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_git_pull, ["project", "repositoryPath", "remoteName", "branch"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_list_wikis, ["project"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_write_wiki_page, ["project", "wikiIdentifier", "path", "content", "comment"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_create_work_item, [
    "project",
    "workItemType",
    "title",
    "description",
    "parentId",
    "areaPath",
    "iterationPath",
    "assignedTo",
    "priority",
    "tags",
    "state",
    "reproSteps",
    "systemInfo",
    "severity",
    "acceptanceCriteria",
    "originalEstimate",
    "remainingWork",
    "completedWork",
    "activity",
    "storyPoints",
    "effort",
    "size",
    "businessValue",
  ]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_update_work_item, [
    "project",
    "workItemId",
    "expectedRev",
    "workItemType",
    "title",
    "description",
    "areaPath",
    "iterationPath",
    "assignedTo",
    "priority",
    "tags",
    "state",
    "reproSteps",
    "systemInfo",
    "severity",
    "acceptanceCriteria",
    "originalEstimate",
    "remainingWork",
    "completedWork",
    "activity",
    "storyPoints",
    "effort",
    "size",
    "businessValue",
  ]);
  assert.equal(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_push.includes("force" as never), false);
  assert.equal(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_push.includes("forceWithLease" as never), false);
});

test("pulls only from the verified fetch remote using the selected repository checkout", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "azure-devops-selected-pull-project-"));
  const repositoryPath = "repository/selected-repository";
  const repositoryWorktree = join(projectRoot, repositoryPath);
  const fetchRemotes: string[] = [];
  const pullCalls: Array<{ branch?: string; credential: string; expectedRemoteUrl: string; remoteName: string; worktree: string }> = [];
  try {
    await mkdir(repositoryWorktree, { recursive: true });
    await git(repositoryWorktree, ["init"]);
    const result = await pullAzureDevOpsWorktree(
      { branch: "feature/pull", repositoryPath },
      {
        git: {
          getFetchRemoteUrls: async (worktree, remoteName) => {
            fetchRemotes.push(`${worktree}:${remoteName}`);
            return [CANONICAL_REMOTE];
          },
          pull: async (worktree, remoteName, branch, credential, expectedRemoteUrl) => {
            pullCalls.push({ branch, credential, expectedRemoteUrl, remoteName, worktree });
          },
        },
        resolvePullPlan: async () => ({
          branch: "feature/pull",
          organization: "contoso",
          project: "ado-project",
          repositoryPath,
          remoteName: "origin",
          resolvedValues: {
            branch: "feature/pull",
            organization: "contoso",
            project: "ado-project",
            remoteName: "origin",
            repositoryPath,
          },
          sources: { branch: "agent", organization: "derived", project: "fixed", remoteName: "fixed", repositoryPath: "agent" },
        }),
        resolvePull: async (_input, remoteUrl) => ({
          branch: "feature/pull",
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
          remoteUrl,
        }),
        worktree: repositoryWorktree,
      },
    );

    assert.deepEqual(fetchRemotes, [
      `${repositoryWorktree}:origin`,
      `${repositoryWorktree}:origin`,
    ]);
    assert.deepEqual(pullCalls, [{
      branch: "feature/pull",
      credential: "pat-secret-value",
      expectedRemoteUrl: CANONICAL_REMOTE,
      remoteName: "origin",
      worktree: repositoryWorktree,
    }]);
    assert.deepEqual(result, { branch: "feature/pull", pullResult: "pulled", remoteName: "origin", repositoryPath });
    assert.equal(JSON.stringify(result).includes("pat-secret-value"), false);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("refuses a pull when the fetch remote changes during credential resolution", async () => {
  let credentialIssued = false;
  let pullCalled = false;
  await assert.rejects(
    () => pullAzureDevOpsWorktree(
      { repositoryPath: "repository/selected-repository" },
      {
        git: {
          getFetchRemoteUrls: async () => [credentialIssued
            ? "https://dev.azure.com/contoso/ado-project/_git/attacker"
            : CANONICAL_REMOTE],
          pull: async () => { pullCalled = true; },
        },
        resolvePullPlan: async () => ({
          organization: "contoso",
          project: "ado-project",
          repositoryPath: "repository/selected-repository",
          remoteName: "origin",
          resolvedValues: { organization: "contoso", project: "ado-project", remoteName: "origin", repositoryPath: "repository/selected-repository" },
          sources: { organization: "derived", project: "fixed", remoteName: "fixed", repositoryPath: "agent" },
        }),
        resolvePull: async (_input, remoteUrl) => {
          credentialIssued = true;
          return { credential: "pat-secret-value", organization: "contoso", project: "ado-project", remoteName: "origin", remoteUrl };
        },
        worktree: "C:/project",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PULL_REMOTE_MISMATCH",
  );
  assert.equal(pullCalled, false);
});

test("runs Git pull with a validated remote and a temporary credential", async () => {
  const calls: Array<{ args: string[]; credential?: string }> = [];
  const git = createAzureDevOpsGitOperations({
    execute: async (_worktree, args, options = {}) => {
      calls.push({ args, credential: options.credential });
      return { stderr: "", stdout: args[0] === "remote" ? CANONICAL_REMOTE : "Already up to date." };
    },
  } as never);

  await git.pull("C:/selected-repository", "origin", "feature/pull", "pat-secret-value", CANONICAL_REMOTE, "contoso", "ado-project");

  assert.deepEqual(calls, [
    { args: ["remote", "get-url", "--all", "origin"], credential: undefined },
    { args: ["pull", "origin", "feature/pull"], credential: "pat-secret-value" },
  ]);
});

test("redacts the brokered pull credential from Git failures", async () => {
  await assert.rejects(
    () => pullAzureDevOpsWorktree(
      { repositoryPath: "repository/selected-repository" },
      {
        git: {
          getFetchRemoteUrls: async () => [CANONICAL_REMOTE],
          pull: async (_worktree, _remoteName, _branch, credential) => {
            throw new Error(`Git included ${credential} in its error output.`);
          },
        },
        resolvePullPlan: async () => ({
          organization: "contoso",
          project: "ado-project",
          repositoryPath: "repository/selected-repository",
          remoteName: "origin",
          resolvedValues: { organization: "contoso", project: "ado-project", remoteName: "origin", repositoryPath: "repository/selected-repository" },
          sources: { organization: "derived", project: "fixed", remoteName: "fixed", repositoryPath: "agent" },
        }),
        resolvePull: async (_input, remoteUrl) => ({
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
          remoteUrl,
        }),
        worktree: "C:/selected-repository",
      },
    ),
    (error: unknown) => {
      assert.equal(errorCode(error), "AZURE_DEVOPS_GIT_PULL_FAILED");
      assert.equal(errorMessage(error).includes("pat-secret-value"), false);
      return true;
    },
  );
});

test("pushes the selected branch to the verified remote without exposing the credential", async () => {
  await withGitWorktree(async (worktree) => {
    const calls: Array<{ branch: string; credential: string; remoteName: string; setUpstream: boolean }> = [];
    const result = await pushAzureDevOpsWorktree(
      { branch: "feature/push", remoteName: "origin" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => [CANONICAL_REMOTE],
          push: async (_worktree, remoteName, branch, setUpstream, credential) => {
            calls.push({ branch, credential, remoteName, setUpstream });
          },
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async (input, remoteUrl, _derivedValues, resolvedPlan) => ({
          branch: String(input.branch),
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: resolvedPlan.remoteName,
          remoteUrl,
          setUpstream: false,
        }),
        worktree,
      },
    );

    assert.deepEqual(calls, [{ branch: "feature/push", credential: "pat-secret-value", remoteName: "origin", setUpstream: false }]);
    assert.equal(result.remoteName, "origin");
    assert.equal(result.branch, "feature/push");
    assert.equal(result.upstream, undefined);
    assert.equal(result.pushResult, "pushed");
    assert.equal(JSON.stringify(result).includes("pat-secret-value"), false);
  });
});

test("pushes from the resolved cloned repository worktree", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "azure-devops-selected-push-project-"));
  const repositoryPath = "repository/selected-repository";
  const repositoryWorktree = join(projectRoot, repositoryPath);
  const observedWorktrees: string[] = [];
  try {
    await mkdir(repositoryWorktree, { recursive: true });
    await git(repositoryWorktree, ["init"]);
    const result = await pushAzureDevOpsWorktree(
      { branch: "main", repositoryPath },
      {
        git: {
          getRemoteUrl: async (worktree) => { observedWorktrees.push(worktree); return CANONICAL_REMOTE; },
          getPushRemoteUrls: async (worktree) => { observedWorktrees.push(worktree); return [CANONICAL_REMOTE]; },
          push: async (worktree) => { observedWorktrees.push(worktree); },
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async (_input, remoteUrl, _derivedValues, plan) => ({
          branch: "main",
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: plan.remoteName,
          remoteUrl,
          setUpstream: false,
        }),
        worktree: repositoryWorktree,
      },
    );

    assert.deepEqual(observedWorktrees, Array(5).fill(repositoryWorktree));
    assert.equal(result.repositoryPath, repositoryPath);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("revalidates the fetch and every push URL after credential resolution", async () => {
  let mutated = false;
  let credentialPassedToPush: string | undefined;

  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main", remoteName: "origin" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => mutated
            ? [CANONICAL_REMOTE, "https://dev.azure.com/contoso/ado-project/_git/attacker"]
            : [CANONICAL_REMOTE],
          push: async (_worktree, _remoteName, _branch, _setUpstream, credential) => {
            credentialPassedToPush = credential;
          },
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async (_input, remoteUrl) => {
          mutated = true;
          return {
            branch: "main",
            credential: "pat-secret-value",
            organization: "contoso",
            project: "ado-project",
            remoteName: "origin",
            remoteUrl,
            setUpstream: false,
          };
        },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REMOTE_MISMATCH",
  );

  assert.equal(credentialPassedToPush, undefined);
});

test("the Git push operation rejects a remote mutation before starting a credential-bearing subprocess", async () => {
  let fetchReads = 0;
  let credentialBearingCalls = 0;
  const git = createAzureDevOpsGitOperations({
    execute: async (_worktree, args, options = {}) => {
      if (options.credential) credentialBearingCalls += 1;
      if (args[0] === "remote" && args[1] === "get-url" && args[2] === "--push") {
        return { stderr: "", stdout: `${CANONICAL_REMOTE}\n` };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        fetchReads += 1;
        return {
          stderr: "",
          stdout: `${fetchReads === 1 ? CANONICAL_REMOTE : "https://dev.azure.com/contoso/ado-project/_git/attacker"}\n`,
        };
      }
      if (args[0] === "rev-parse") {
        fetchReads = 1;
        return { stderr: "", stdout: "main\n" };
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    () => git.push("C:\\controlled\\worktree", "origin", "main", false, "pat-secret-value", CANONICAL_REMOTE),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REMOTE_MISMATCH",
  );
  assert.equal(credentialBearingCalls, 0);
});

test("Git push accepts the organization-qualified URL only after matching its Azure DevOps identity", async () => {
  let pushCalls = 0;
  let credentialBearingCalls = 0;
  const git = createAzureDevOpsGitOperations({
    execute: async (_worktree, args, options = {}) => {
      if (options.credential) credentialBearingCalls += 1;
      if (args[0] === "remote" && args[1] === "get-url") return { stderr: "", stdout: `${ORGANIZATION_QUALIFIED_REMOTE}\n` };
      if (args[0] === "rev-parse") return { stderr: "", stdout: "main\n" };
      if (args[0] === "push") {
        pushCalls += 1;
        return { stderr: "", stdout: "" };
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    },
  });

  await git.push(
    "C:\\controlled\\worktree",
    "origin",
    "main",
    false,
    "pat-secret-value",
    CANONICAL_REMOTE,
    "contoso",
    "ado-project",
  );

  assert.equal(pushCalls, 1);
  assert.equal(credentialBearingCalls, 1);
});

test("resolves the push policy remote before reading fetch and push URLs", async () => {
  const remoteReads: Array<{ kind: string; remoteName: string }> = [];
  const result = await pushAzureDevOpsWorktree(
    { branch: "main", remoteName: "origin" },
    {
      git: {
        getRemoteUrl: async (_worktree, remoteName) => {
          remoteReads.push({ kind: "fetch", remoteName });
          return CANONICAL_REMOTE;
        },
        getPushRemoteUrls: async (_worktree, remoteName) => {
          remoteReads.push({ kind: "push", remoteName });
          return [CANONICAL_REMOTE];
        },
        push: async () => undefined,
      },
      resolvePushPlan: async () => ({
        branch: "main",
        organization: "contoso",
        project: "ado-project",
        repositoryPath: "repository/selected-repository",
        remoteName: "deploy",
        resolvedValues: {
          branch: "main",
          organization: "contoso",
          project: "ado-project",
          repositoryPath: "repository/selected-repository",
          remoteName: "deploy",
          setUpstream: false,
        },
        setUpstream: false,
        sources: { branch: "agent", organization: "derived", project: "fixed", repositoryPath: "fixed", remoteName: "fixed", setUpstream: "agent" },
      }),
      resolvePush: async (_input, remoteUrl, _derivedValues, resolvedPlan) => ({
        branch: "main",
        credential: "pat-secret-value",
        organization: "contoso",
        project: "ado-project",
        remoteName: resolvedPlan.remoteName,
        remoteUrl,
        setUpstream: false,
      }),
      worktree: "C:\\controlled\\worktree",
    },
  );

  assert.deepEqual(remoteReads, [
    { kind: "fetch", remoteName: "deploy" },
    { kind: "push", remoteName: "deploy" },
    { kind: "fetch", remoteName: "deploy" },
    { kind: "push", remoteName: "deploy" },
  ]);
  assert.equal(result.remoteName, "deploy");
});

test("rejects a missing or invalid push preflight plan with a bounded diagnostic", async () => {
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => { throw new Error("must not read a remote"); },
          getPushRemoteUrls: async () => { throw new Error("must not read a push remote"); },
          push: async () => undefined,
        },
        resolvePushPlan: async () => undefined as never,
        resolvePush: async () => { throw new Error("must not request a credential"); },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => {
      assert.equal(errorCode(error), "AZURE_DEVOPS_OPERATION_PLAN_INVALID");
      assert.equal(errorMessage(error).length <= 8_000, true);
      return true;
    },
  );
});

test("reports an explicit upstream when the optional upstream behavior is enabled", async () => {
  const calls: Array<{ branch: string; remoteName: string; setUpstream: boolean }> = [];
  const result = await pushAzureDevOpsWorktree(
    { branch: "main", setUpstream: true },
    {
      git: {
        getRemoteUrl: async () => CANONICAL_REMOTE,
        getPushRemoteUrls: async () => [CANONICAL_REMOTE],
        push: async (_worktree, remoteName, branch, setUpstream) => calls.push({ branch, remoteName, setUpstream }),
      },
      resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
      resolvePush: async (_input, remoteUrl) => ({
        branch: "main",
        credential: "pat-secret-value",
        organization: "contoso",
        project: "ado-project",
        remoteName: "origin",
        remoteUrl,
        setUpstream: true,
      }),
      worktree: "C:\\controlled\\worktree",
    },
  );

  assert.deepEqual(calls, [{ branch: "main", remoteName: "origin", setUpstream: true }]);
  assert.deepEqual(result.upstream, { branch: "main", remoteName: "origin" });
});

test("push accepts Microsoft's organization-qualified HTTPS clone URL after normalizing it", async () => {
  const pushes: Array<{ remoteName: string; branch: string; remoteUrl: string }> = [];
  const result = await pushAzureDevOpsWorktree(
    { branch: "main", remoteName: "origin" },
    {
      git: {
        getRemoteUrl: async () => ORGANIZATION_QUALIFIED_REMOTE,
        getPushRemoteUrls: async () => [ORGANIZATION_QUALIFIED_REMOTE],
        push: async (_worktree, remoteName, branch, _setUpstream, _credential, remoteUrl) => {
          pushes.push({ remoteName, branch, remoteUrl: remoteUrl ?? "" });
        },
      },
      resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
      resolvePush: async (_input, remoteUrl, _derivedValues, plan) => ({
        branch: "main",
        credential: "pat-secret-value",
        organization: "contoso",
        project: "ado-project",
        remoteName: plan.remoteName,
        remoteUrl,
        setUpstream: false,
      }),
      worktree: "C:\\controlled\\worktree",
    },
  );

  assert.deepEqual(pushes, [{ remoteName: "origin", branch: "main", remoteUrl: CANONICAL_REMOTE }]);
  assert.equal(result.pushResult, "pushed");
  assert.equal(result.remoteUrl, undefined);
});

test("rejects a push remote that differs from the fetch remote before credential resolution", async () => {
  let resolved = false;
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => ["https://dev.azure.com/contoso/ado-project/_git/other-repository"],
          push: async () => undefined,
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REMOTE_MISMATCH",
  );
  assert.equal(resolved, false);
});

test("rejects multiple configured push URLs before credential resolution", async () => {
  let resolved = false;
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => [CANONICAL_REMOTE, CANONICAL_REMOTE],
          push: async () => undefined,
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_REMOTE_MISMATCH",
  );
  assert.equal(resolved, false);
});

test("rejects a push plan whose resolved parameter source set is incomplete", async () => {
  let remoteRead = false;
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => {
            remoteRead = true;
            return CANONICAL_REMOTE;
          },
          getPushRemoteUrls: async () => [CANONICAL_REMOTE],
          push: async () => undefined,
        },
        resolvePushPlan: async () => ({
          branch: "main",
          organization: "contoso",
          project: "ado-project",
          repositoryPath: "repository/selected-repository",
          remoteName: "origin",
          resolvedValues: {
            branch: "main",
            organization: "contoso",
            project: "ado-project",
            repositoryPath: "repository/selected-repository",
            remoteName: "origin",
            setUpstream: false,
          },
          setUpstream: false,
          sources: {
            branch: "agent",
            organization: "derived",
            project: "fixed",
            remoteName: "fixed",
          },
        }),
        resolvePush: async () => { throw new Error("must not resolve"); },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_OPERATION_PLAN_INVALID",
  );
  assert.equal(remoteRead, false);
});

test("derives the branch only from the current worktree when the policy requests a derived branch", async () => {
  let derived: Record<string, unknown> | undefined;
  const result = await pushAzureDevOpsWorktree(
    {},
    {
      git: {
        getCurrentBranch: async () => "feature/current",
        getRemoteUrl: async () => CANONICAL_REMOTE,
        getPushRemoteUrls: async () => [CANONICAL_REMOTE],
        push: async () => undefined,
      },
      resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
      resolvePush: async (_input, remoteUrl, derivedValues) => {
        derived = derivedValues;
        return {
          branch: String(derivedValues?.branch),
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
          remoteUrl,
          setUpstream: false,
        };
      },
      worktree: "C:\\controlled\\worktree",
    },
  );

  assert.deepEqual(derived, { branch: "feature/current" });
  assert.equal(result.branch, "feature/current");
});

test("maps a missing remote before asking the broker for a credential", async () => {
  let resolved = false;
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => undefined,
          getPushRemoteUrls: async () => undefined,
          push: async () => undefined,
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async () => {
          resolved = true;
          throw new Error("must not resolve");
        },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REMOTE_NOT_FOUND",
  );
  assert.equal(resolved, false);
});

test("maps a missing resolved branch without invoking Git push", async () => {
  let pushed = false;
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      {},
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => [CANONICAL_REMOTE],
          push: async () => { pushed = true; },
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async (_input, remoteUrl) => ({
          branch: undefined as never,
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
          remoteUrl,
          setUpstream: false,
        }),
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_BRANCH_REQUIRED",
  );
  assert.equal(pushed, false);
});

test("maps broker and Git failures to bounded secret-safe diagnostics", async () => {
  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => [CANONICAL_REMOTE],
          push: async () => undefined,
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async () => {
          throw codedError("AZURE_DEVOPS_CREDENTIAL_BROKER_UNAVAILABLE", "broker failed with pat-secret-value");
        },
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => {
      assert.equal(errorCode(error), "AZURE_DEVOPS_CREDENTIAL_BROKER_UNAVAILABLE");
      assert.equal(errorMessage(error).includes("pat-secret-value"), false);
      return true;
    },
  );

  await assert.rejects(
    () => pushAzureDevOpsWorktree(
      { branch: "main" },
      {
        git: {
          getRemoteUrl: async () => CANONICAL_REMOTE,
          getPushRemoteUrls: async () => [CANONICAL_REMOTE],
          push: async () => { throw codedError("GIT_FAILED", "remote rejected pat-secret-value"); },
        },
        resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
        resolvePush: async (_input, remoteUrl) => ({
          branch: "main",
          credential: "pat-secret-value",
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
          remoteUrl,
          setUpstream: false,
        }),
        worktree: "C:\\controlled\\worktree",
      },
    ),
    (error: unknown) => {
      assert.equal(errorCode(error), "AZURE_DEVOPS_GIT_PUSH_FAILED");
      assert.equal(errorMessage(error).includes("pat-secret-value"), false);
      return true;
    },
  );
});

test("rejects overwrite inputs before Git and leaves the local Git config unchanged", async () => {
  await withGitWorktree(async (worktree) => {
    const before = await readFile(join(worktree, ".git", "config"), "utf8");
    let pushed = false;
    await assert.rejects(
      () => pushAzureDevOpsWorktree(
        { branch: "main", forceWithLease: true },
        {
          git: {
            getRemoteUrl: async () => CANONICAL_REMOTE,
            getPushRemoteUrls: async () => [CANONICAL_REMOTE],
            push: async () => { pushed = true; },
          },
          resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
          resolvePush: async () => {
            throw new Error("must not resolve");
          },
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PUSH_OVERWRITE_FORBIDDEN",
    );
    assert.equal(pushed, false);
    assert.equal(await readFile(join(worktree, ".git", "config"), "utf8"), before);
  });
});

test("keeps the broker credential in the Git process environment and out of args and output", async () => {
  const previousEnvironment = {
    EXTENSION_SECRET_KEY: process.env.EXTENSION_SECRET_KEY,
    GIT_TRACE: process.env.GIT_TRACE,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    PERSONAL_ACCESS_TOKEN: process.env.PERSONAL_ACCESS_TOKEN,
    UNAPPROVED_RUNTIME_SECRET: process.env.UNAPPROVED_RUNTIME_SECRET,
  };
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET;
  process.env.GIT_TRACE = "trace-secret-value";
  process.env.GIT_CONFIG_GLOBAL = "C:\\attacker\\global.gitconfig";
  process.env.GIT_CONFIG_NOSYSTEM = "0";
  process.env.PERSONAL_ACCESS_TOKEN = "pat-environment-value";
  process.env.UNAPPROVED_RUNTIME_SECRET = "unapproved-runtime-secret";
  let credentialSeenByRunner: string | undefined;
  let environmentSeenByRunner: NodeJS.ProcessEnv | undefined;
  let argsSeenByRunner: string[] = [];
  try {
    const gitProcess = createAzureDevOpsGitProcess(async (_file, args, options) => {
      argsSeenByRunner = args;
      environmentSeenByRunner = options.env;
      credentialSeenByRunner = options.env.AZURE_DEVOPS_GIT_PASSWORD;
      return { stderr: "remote rejected pat-secret-value extension-secret-value", stdout: "" };
    });

    const result = await gitProcess.execute("C:\\controlled\\worktree", ["push", "origin", "main"], {
      credential: "pat-secret-value",
      operation: "Azure DevOps Git push",
    });

    assert.equal(credentialSeenByRunner, "pat-secret-value");
    assert.equal(environmentSeenByRunner?.EXTENSION_SECRET_KEY, undefined);
    assert.equal(environmentSeenByRunner?.PERSONAL_ACCESS_TOKEN, undefined);
    assert.equal(environmentSeenByRunner?.GIT_TRACE, undefined);
    assert.equal(environmentSeenByRunner?.UNAPPROVED_RUNTIME_SECRET, undefined);
    assert.equal(environmentSeenByRunner?.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environmentSeenByRunner?.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.equal(environmentSeenByRunner?.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(argsSeenByRunner.join(" ").includes("pat-secret-value"), false);
    assert.equal(JSON.stringify(result).includes("pat-secret-value"), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
  } finally {
    restoreEnvironment("EXTENSION_SECRET_KEY", previousEnvironment.EXTENSION_SECRET_KEY);
    restoreEnvironment("GIT_TRACE", previousEnvironment.GIT_TRACE);
    restoreEnvironment("GIT_CONFIG_GLOBAL", previousEnvironment.GIT_CONFIG_GLOBAL);
    restoreEnvironment("GIT_CONFIG_NOSYSTEM", previousEnvironment.GIT_CONFIG_NOSYSTEM);
    restoreEnvironment("PERSONAL_ACCESS_TOKEN", previousEnvironment.PERSONAL_ACCESS_TOKEN);
    restoreEnvironment("UNAPPROVED_RUNTIME_SECRET", previousEnvironment.UNAPPROVED_RUNTIME_SECRET);
  }
});

test("clears inherited Git credential helpers before injecting the temporary helper", async () => {
  let argsSeenByRunner: string[] = [];
  const gitProcess = createAzureDevOpsGitProcess(async (_file, args) => {
    argsSeenByRunner = args;
    return { stderr: "", stdout: "" };
  });

  await gitProcess.execute("C:\\controlled\\worktree", ["push", "origin", "main"], {
    credential: "pat-secret-value",
    operation: "Azure DevOps Git push",
  });

  assert.deepEqual(argsSeenByRunner.slice(0, 2), ["-c", "credential.helper="]);
  assert.equal(argsSeenByRunner[2], "-c");
  assert.match(argsSeenByRunner[3] ?? "", /^credential\.helper=!/);
  assert.equal(argsSeenByRunner.join(" ").includes("pat-secret-value"), false);
});

test("uses a minimal allowlist for Git environments and redacts bounded runtime secrets", async () => {
  let environmentSeenByRunner: NodeJS.ProcessEnv | undefined;
  const gitProcess = createAzureDevOpsGitProcess(async (_file, _args, options) => {
    environmentSeenByRunner = options.env;
    throw Object.assign(new Error("clone failed with pat-secret-value"), { stderr: "clone failed with pat-secret-value" });
  });

  await assert.rejects(
    () => gitProcess.execute("C:\\controlled\\worktree", ["clone", CANONICAL_REMOTE, "repository"], {
      credential: "pat-secret-value",
      operation: "Clone Git repository",
    }),
    (error: unknown) => {
      assert.equal(errorCode(error), "AZURE_DEVOPS_GIT_FAILED");
      assert.equal(errorMessage(error).includes("pat-secret-value"), false);
      assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
      return true;
    },
  );

  assert.equal(environmentSeenByRunner?.AZURE_DEVOPS_GIT_PASSWORD, "pat-secret-value");
  assert.equal(environmentSeenByRunner?.GIT_ASKPASS?.includes("AZURE_DEVOPS_GIT_PASSWORD"), true);
  assert.equal(environmentSeenByRunner?.EXTENSION_SECRET_KEY, undefined);
  assert.equal(environmentSeenByRunner?.PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(environmentSeenByRunner?.GIT_TRACE, undefined);
});

test("repository backend errors preserve HTTP and sanitized Azure DevOps diagnostics", async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      code: "ADO_REPOSITORY_CREATE_FAILED",
      message: `The Azure DevOps repository could not be created. ${EXTENSION_SECRET}`,
      requestID: "req-create-repository",
      details: {
        upstreamStatus: 400,
        upstreamCode: "ProjectReferenceRequired",
        upstreamMessage: "The project ID is required.",
        upstreamInnerMessage: "ProjectReference.id is missing.",
      },
    },
  }), { headers: { "content-type": "application/json" }, status: 400 });

  try {
    await assert.rejects(
      () => callRepositoryBackend("agent", "create-repository", { tool: "azure_devops_create_repository" }),
      (error: unknown) => {
        const details = error && typeof error === "object" && "details" in error
          ? error.details as Record<string, unknown>
          : {};
        assert.equal(errorCode(error), "ADO_REPOSITORY_CREATE_FAILED");
        assert.match(errorMessage(error), /HTTP 400/);
        assert.match(errorMessage(error), /ProjectReferenceRequired/);
        assert.match(errorMessage(error), /ProjectReference\.id is missing/);
        assert.equal(details.httpStatus, 400);
        assert.equal(details.requestID, "req-create-repository");
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
  }
});

test("clone uses the V2 Tool worktree context without a legacy metadata callback", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "azure-devops-plugin-v2-context-clone-"));
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
  let requestPath: string | undefined;
  process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
  globalThis.fetch = async (input) => {
    requestPath = new URL(String(input)).pathname;
    return new Response(JSON.stringify({ error: { code: "AZURE_DEVOPS_DIAGNOSTIC_STOP", message: "Stop before Git clone." } }), {
      headers: { "content-type": "application/json" },
      status: 503,
    });
  };

  try {
    const plugin = await createAzureDevOpsToolDefinitions({ directory: worktree, project: "managed-project" } as never);
    const cloneTool = plugin.azure_devops_clone_repository;
    await assert.rejects(
      () => cloneTool.execute(
        { repositoryName: "repository", destination: "repository" },
        {
          directory: worktree,
          worktree,
        } as never,
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_DIAGNOSTIC_STOP",
    );

    assert.equal(requestPath, "/bff/extensions/azure-devops-platform/backend/clone-repository");
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    await rm(worktree, { force: true, recursive: true });
  }
});

test("clone maps runtime split errors to a bounded failure stage", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "azure-devops-plugin-runtime-clone-"));
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
  process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
  globalThis.fetch = async () => {
    throw "undefined is not an object (evaluating 'c.split')";
  };

  try {
    const plugin = await createAzureDevOpsToolDefinitions({ directory: worktree, project: "managed-project" } as never);
    await assert.rejects(
      () => plugin.azure_devops_clone_repository.execute(
        { repositoryName: "repository", destination: "repository" },
        { worktree } as never,
      ),
      (error: unknown) => {
        assert.equal(errorCode(error), "AZURE_DEVOPS_CLONE_RUNTIME_FAILED");
        assert.match(errorMessage(error), /Azure DevOps repository lookup/);
        assert.equal(errorMessage(error).includes("c.split"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    await rm(worktree, { force: true, recursive: true });
  }
});

test("rejects missing operation plans and follows the backend-resolved parameters", async () => {
  await withGitWorktree(async (worktree) => {
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    let includeOperationPlan = false;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...(includeOperationPlan ? {
        operationPlan: {
          parameters: { remoteName: "deploy", updateExisting: true },
          tool: "azure_devops_configure_remote",
        },
      } : {}),
      repository: metadata,
    }), { headers: { "content-type": "application/json" }, status: 200 });
    try {
      const plugin = await createAzureDevOpsToolDefinitions({ directory: worktree, project: "managed-project" } as never);
      const configureTool = plugin.azure_devops_configure_remote;
      await assert.rejects(
        () => configureTool.execute({ remoteName: "origin" }, { worktree } as never),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_OPERATION_PLAN_REQUIRED",
      );

      await git(worktree, ["remote", "add", "origin", "https://dev.azure.com/contoso/ado-project/_git/old"]);
      includeOperationPlan = true;
      const result = await configureTool.execute({ remoteName: "origin" }, { worktree } as never) as { content: string; metadata?: Record<string, unknown> };

      assert.equal(result.metadata?.title, "Azure DevOps remote configured");
      assert.equal(JSON.parse(result.content).remoteName, "deploy");
      assert.equal(await gitConfig(worktree, "remote.deploy.url"), CANONICAL_REMOTE);
      assert.equal(await gitConfig(worktree, "remote.origin.url"), "https://dev.azure.com/contoso/ado-project/_git/old");
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    }
  });
});

test("configure remote targets the selected nested repository and leaves the parent remote untouched", async () => {
  await withGitWorktree(async (projectWorktree) => {
    const repositoryPath = "repository/solo-block-stacker";
    const nestedWorktree = join(projectWorktree, repositoryPath);
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    const requestBodies: Array<Record<string, unknown>> = [];
    try {
      await mkdir(nestedWorktree, { recursive: true });
      await git(nestedWorktree, ["init"]);
      await git(projectWorktree, ["remote", "add", "origin", "https://example.test/parent-worktree"]);

      process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
      globalThis.fetch = async (_input, init = {}) => {
        if (typeof init.body === "string") requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return new Response(JSON.stringify({
          operationPlan: {
            parameters: {
              organization: "contoso",
              project: "ado-project",
              repositoryPath,
              remoteName: "origin",
            },
            tool: "azure_devops_configure_remote",
          },
          repository: metadata,
        }), { headers: { "content-type": "application/json" }, status: 200 });
      };

      const plugin = await createAzureDevOpsToolDefinitions({
        directory: projectWorktree,
        project: "managed-project",
        worktree: projectWorktree,
      } as never);
      const configureTool = plugin.azure_devops_configure_remote;
      const input = { repositoryID: REPOSITORY_ID, repositoryPath };
      const first = await configureTool.execute(input, { worktree: projectWorktree } as never) as { content: string };
      const second = await configureTool.execute({ repositoryID: REPOSITORY_ID }, { worktree: projectWorktree } as never) as { content: string };

      assert.equal(await gitConfig(nestedWorktree, "remote.origin.url"), CANONICAL_REMOTE);
      assert.equal(await gitConfig(projectWorktree, "remote.origin.url"), "https://example.test/parent-worktree");
      assert.equal(JSON.parse(first.content).changed, true);
      assert.equal(JSON.parse(first.content).repositoryPath, repositoryPath);
      assert.equal(JSON.parse(second.content).changed, false);
      assert.equal(JSON.parse(second.content).repositoryPath, repositoryPath);
      assert.equal(requestBodies.length, 2);
      assert.equal((requestBodies[0]?.agentInput as Record<string, unknown>)?.repositoryPath, repositoryPath);
      assert.equal((requestBodies[1]?.agentInput as Record<string, unknown>)?.repositoryPath, undefined);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    }
  });
});

test("configure remote auto-targets a same-name nested repository when repositoryPath is omitted", async () => {
  const projectWorktree = await mkdtemp(join(tmpdir(), "azure-devops-configure-remote-inferred-project-"));
  const repositoryName = "solo-block-stacker";
  const nestedWorktree = join(projectWorktree, "repository", repositoryName);
  const nestedMetadata = {
    ...metadata,
    name: repositoryName,
    remoteUrl: `https://dev.azure.com/contoso/ado-project/_git/${repositoryName}`,
  };
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
  try {
    await mkdir(nestedWorktree, { recursive: true });
    await git(nestedWorktree, ["init"]);
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
    globalThis.fetch = async () => new Response(JSON.stringify({
      operationPlan: {
        parameters: {
          organization: "contoso",
          project: "ado-project",
          remoteName: "origin",
        },
        tool: "azure_devops_configure_remote",
      },
      repository: nestedMetadata,
    }), { headers: { "content-type": "application/json" }, status: 200 });

    const plugin = await createAzureDevOpsToolDefinitions({
      directory: projectWorktree,
      project: "managed-project",
    } as never);
    const result = await plugin.azure_devops_configure_remote.execute(
      { repositoryName },
      { directory: projectWorktree } as never,
    ) as { content: string };

    assert.equal(await gitConfig(nestedWorktree, "remote.origin.url"), nestedMetadata.remoteUrl);
    assert.equal(JSON.parse(result.content).repositoryPath, `repository/${repositoryName}`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    await rm(projectWorktree, { force: true, recursive: true });
  }
});

test("push execute resolves and uses the configured repositoryPath before inspecting Git remotes", async () => {
  await withGitFixture(async ({ worktree }) => {
    const pluginInputWorktree = await mkdtemp(join(tmpdir(), "azure-devops-plugin-stale-worktree-"));
    const selectedWorktree = join(worktree, "repository", "selected-repository");
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    const requestBodies: Array<Record<string, unknown>> = [];
    const requestPaths: string[] = [];
    try {
      await git(pluginInputWorktree, ["init"]);
      await git(worktree, ["remote", "add", "origin", "https://attacker.example/incorrect-repository"]);
      await mkdir(selectedWorktree, { recursive: true });
      await git(selectedWorktree, ["init"]);
      await git(selectedWorktree, ["config", "user.email", "fixture@example.test"]);
      await git(selectedWorktree, ["config", "user.name", "Fixture"]);
      await writeFile(join(selectedWorktree, "README.md"), "selected repository\n");
      await git(selectedWorktree, ["add", "README.md"]);
      await git(selectedWorktree, ["commit", "-m", "selected repository"]);
      await git(selectedWorktree, ["branch", "--move", "main"]);
      await git(selectedWorktree, ["remote", "add", "origin", CANONICAL_REMOTE]);

      process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-backend.test";
      globalThis.fetch = async (_input, init = {}) => {
        if (typeof init.body === "string") requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        const requestURL = new URL(String(_input));
        const requestPath = requestURL.pathname.split("/").at(-1) ?? "";
        requestPaths.push(requestPath);
        const body = requestPath === "push-plan"
          ? {
            operationPlan: {
              parameters: {
                branch: "main",
                organization: "contoso",
                project: "ado-project",
                repositoryPath: "repository/selected-repository",
                remoteName: "origin",
                setUpstream: false,
              },
              sources: {
                branch: "agent",
                organization: "derived",
                project: "fixed",
                repositoryPath: "agent",
                remoteName: "fixed",
                setUpstream: "agent",
              },
              tool: "azure_devops_push",
            },
          }
            : {
            branch: "main",
            organization: "contoso",
            project: "ado-project",
            remoteName: "origin",
            remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository",
            setUpstream: false,
            token: "pat-secret-value",
          };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
      };

      const plugin = await createAzureDevOpsToolDefinitions({ directory: pluginInputWorktree, project: "managed-project" } as never);
      await assert.rejects(
        () => plugin.azure_devops_push.execute(
          { branch: "main", repositoryPath: "repository/selected-repository" },
          { worktree, metadata: () => undefined } as never,
        ),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_MISMATCH",
      );
      assert.deepEqual(requestPaths, ["push-plan", "push-credential"]);
      assert.equal((requestBodies[1]?.agentInput as Record<string, unknown>)?.repositoryPath, "repository/selected-repository");
      assert.deepEqual(requestBodies[1]?.verifiedResolvedValues, {
        branch: "main",
        organization: "contoso",
        project: "ado-project",
        repositoryPath: "repository/selected-repository",
        remoteName: "origin",
        setUpstream: false,
      });
      assert.deepEqual(requestBodies[1]?.verifiedResolvedSources, {
        branch: "agent",
        organization: "derived",
        project: "fixed",
        repositoryPath: "agent",
        remoteName: "fixed",
        setUpstream: "agent",
      });
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
      await rm(pluginInputWorktree, { force: true, recursive: true });
    }
  });
});

test("pushes a controlled Git fixture without writing credential configuration", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "azure-devops-plugin-push-worktree-"));
  const bareRepository = await mkdtemp(join(tmpdir(), "azure-devops-plugin-push-remote-"));
  try {
    await git(worktree, ["init"]);
    await git(bareRepository, ["init", "--bare"]);
    await git(worktree, ["config", "user.email", "test@example.invalid"]);
    await git(worktree, ["config", "user.name", "Azure DevOps test"]);
    await writeFile(join(worktree, "README.md"), "controlled push fixture\n");
    await git(worktree, ["add", "README.md"]);
    await git(worktree, ["commit", "--message", "fixture"]);
    await git(worktree, ["branch", "--move", "main"]);
    const bareRemote = pathToFileURL(bareRepository).href;
    await git(worktree, ["remote", "add", "origin", bareRemote]);
    const before = await readFile(join(worktree, ".git", "config"), "utf8");

    await createAzureDevOpsGitOperations().push(worktree, "origin", "main", false, "pat-secret-value", bareRemote);

    assert.match(await git(bareRepository, ["show-ref", "refs/heads/main"]), /refs\/heads\/main/);
    const after = await readFile(join(worktree, ".git", "config"), "utf8");
    assert.equal(after, before);
    assert.equal(after.includes("pat-secret-value"), false);
    assert.equal(after.includes("credential.helper"), false);
  } finally {
    await rm(worktree, { force: true, recursive: true });
    await rm(bareRepository, { force: true, recursive: true });
  }
});

test("clones a resolved repository into the default destination and keeps Git-created origin", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await cloneAzureDevOpsRepository(
      { repositoryReference: metadata.repositoryReference },
      {
        git: createFixtureCloneGit(source, calls),
        getCredential: async () => "pat-secret-value",
        resolveRepository: async () => metadata,
        worktree,
      },
    );

    assert.equal(result.destination, "repository/repository");
    assert.equal(result.path, "repository/repository");
    assert.equal(result.remoteName, "origin");
    assert.equal(result.remoteUrl, CANONICAL_REMOTE);
    assert.deepEqual(result.selection, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.remoteUrl, CANONICAL_REMOTE);
    assert.equal(calls[0]?.credential, "pat-secret-value");
    assert.notEqual(calls[0]?.destination, join(worktree, "repository", "repository"));
    assert.equal(relative(worktree, String(calls[0]?.destination)).startsWith(`repository${process.platform === "win32" ? "\\" : "/"}`), true);
    assert.equal(await gitConfig(join(worktree, "repository", "repository"), "remote.origin.url"), CANONICAL_REMOTE);
    assert.equal(JSON.stringify(result).includes("pat-secret-value"), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
  });
});

test("clones from normalized Azure DevOps organization-qualified metadata", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await cloneAzureDevOpsRepository(
      { repositoryReference: metadata.repositoryReference },
      {
        git: createFixtureCloneGit(source, calls),
        getCredential: async () => "pat-secret-value",
        resolveRepository: async () => ({ ...metadata, remoteUrl: ORGANIZATION_QUALIFIED_REMOTE }),
        worktree,
      },
    );

    assert.equal(result.remoteUrl, CANONICAL_REMOTE);
    assert.equal(calls[0]?.remoteUrl, CANONICAL_REMOTE);
    assert.equal(await gitConfig(join(worktree, "repository", "repository"), "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("keeps multiple selected repositories under the same project-local repository directory", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const dependencies = {
      git: createFixtureCloneGit(source, []),
      getCredential: async () => "pat-secret-value",
      resolveRepository: async () => metadata,
      worktree,
    };

    const first = await cloneAzureDevOpsRepository({ repositoryName: metadata.name }, dependencies);
    const second = await cloneAzureDevOpsRepository({ repositoryName: metadata.name, destination: "second-repository" }, dependencies);
    const repositoryRoot = join(worktree, "repository");

    assert.equal(first.destination, "repository/repository");
    assert.equal(second.destination, "repository/second-repository");
    assert.deepEqual((await readdir(repositoryRoot)).sort(), ["repository", "second-repository"]);
    assert.equal(await gitConfig(join(repositoryRoot, "repository"), "remote.origin.url"), CANONICAL_REMOTE);
    assert.equal(await gitConfig(join(repositoryRoot, "second-repository"), "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("rejects a clone whose origin is unsafe or differs from the verified repository and cleans staging", async () => {
  for (const originUrl of [
    "https://dev.azure.com/contoso/ado-project/_git/other-repository",
    "https://user:pat-secret-value@dev.azure.com/contoso/ado-project/_git/repository",
  ]) {
    await withGitFixture(async ({ worktree, source }) => {
      const baseGit = createAzureDevOpsGitOperations();
      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryReference: metadata.repositoryReference },
          {
            git: {
              ...baseGit,
              async clone(input) {
                await gitCommand(input.worktree, ["clone", source, input.destination]);
                await gitCommand(input.destination, ["remote", "set-url", "origin", originUrl]);
              },
            },
            getCredential: async () => "pat-secret-value",
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_ORIGIN_MISMATCH",
      );

      assert.deepEqual(await readdir(join(worktree, "repository")), []);
    });
  }
});

test("removes the committed destination when post-rename clone verification fails", async () => {
  await withGitFixture(async ({ worktree }) => {
    const baseGit = createAzureDevOpsGitOperations();
    await assert.rejects(
      cloneAzureDevOpsRepository(
        { repositoryReference: metadata.repositoryReference },
        {
          git: {
            ...baseGit,
            async clone() {},
            async getRemoteUrl(currentPath, remoteName) {
              if (currentPath.includes(".azure-devops-clone-staging-")) return CANONICAL_REMOTE;
              return baseGit.getRemoteUrl(currentPath, remoteName);
            },
          },
          getCredential: async () => "pat-secret-value",
          resolveRepository: async () => metadata,
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_CONFLICT",
    );

    assert.deepEqual(await readdir(join(worktree, "repository")), []);
  });
});

test("aborts a staged clone when the validated destination is replaced before commit", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const outside = await mkdtemp(join(tmpdir(), "azure-devops-clone-commit-outside-"));
    const stagingPaths: string[] = [];
    try {
      const baseGit = createAzureDevOpsGitOperations();
      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryName: metadata.name },
          {
            git: {
              ...baseGit,
              async clone(input) {
                stagingPaths.push(input.destination);
                await gitCommand(input.worktree, ["clone", source, input.destination]);
                await gitCommand(input.destination, ["remote", "set-url", "origin", CANONICAL_REMOTE]);
                try {
                  await symlink(outside, join(worktree, "repository", "repository"), process.platform === "win32" ? "junction" : "dir");
                } catch (error) {
                  if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
                  throw error;
                }
              },
            },
            getCredential: async () => "pat-secret-value",
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => [
          "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
          "AZURE_DEVOPS_CLONE_DESTINATION_CONFLICT",
        ].includes(errorCode(error) ?? ""),
      );

      if (process.platform === "win32" && stagingPaths.length === 0) return;
      assert.equal(stagingPaths.length, 1);
      assert.equal((await readdir(join(worktree, "repository"))).some((entry) => entry.startsWith(".azure-devops-clone-staging-")), false);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("aborts a staged clone when the controlled destination parent is replaced before commit", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const outside = await mkdtemp(join(tmpdir(), "azure-devops-clone-parent-replacement-"));
    try {
      const baseGit = createAzureDevOpsGitOperations();
      let replaced = false;
      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryName: metadata.name },
          {
            git: {
              ...baseGit,
              async clone(input) {
                await gitCommand(input.worktree, ["clone", source, input.destination]);
                await gitCommand(input.destination, ["remote", "set-url", "origin", CANONICAL_REMOTE]);
              },
              async getRemoteUrl(currentPath, remoteName) {
                const url = await baseGit.getRemoteUrl(currentPath, remoteName);
                if (!replaced && currentPath.includes(".azure-devops-clone-staging-")) {
                  replaced = true;
                  const movedPath = join(outside, "moved-worktree");
                  await rename(worktree, movedPath);
                  try {
                    await symlink(movedPath, worktree, process.platform === "win32" ? "junction" : "dir");
                  } catch (error) {
                    if (!(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")) throw error;
                  }
                }
                return url;
              },
            },
            getCredential: async () => "pat-secret-value",
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => [
          "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
          "AZURE_DEVOPS_CLONE_DESTINATION_CONFLICT",
        ].includes(errorCode(error) ?? ""),
      );
      assert.equal((await readdir(join(outside, "moved-worktree", "repository"))).includes(metadata.name), false);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("reports the effective branch/ref and depth selection without changing the remote setup", async () => {
  await withGitFixture(async ({ worktree, source }) => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await cloneAzureDevOpsRepository(
      { repositoryName: metadata.name, ref: "refs/heads/main", depth: 1, destination: "repository" },
      {
        git: createFixtureCloneGit(source, calls),
        getCredential: async () => "pat-secret-value",
        resolveRepository: async () => metadata,
        worktree,
      },
    );

    assert.deepEqual(result.selection, { ref: "refs/heads/main", depth: 1 });
    assert.equal(calls[0]?.ref, "refs/heads/main");
    assert.equal(calls[0]?.depth, 1);
    assert.equal(await gitConfig(join(worktree, "repository", "repository"), "remote.origin.url"), CANONICAL_REMOTE);
  });
});

test("rejects nested destinations before credential or Git side effects", async () => {
  await withGitFixture(async ({ worktree }) => {
    const calls: Array<Record<string, unknown>> = [];
    let brokerCalls = 0;
    await assert.rejects(
      () => cloneAzureDevOpsRepository(
        { repositoryName: metadata.name, ref: "refs/heads/main", depth: 1, destination: "nested/repository" },
        {
          git: createNoopCloneGit(() => calls.push({ called: true })),
          getCredential: async () => { brokerCalls += 1; return "pat-secret-value"; },
          resolveRepository: async () => metadata,
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
    );

    assert.equal(calls.length, 0);
    assert.equal(brokerCalls, 0);
    assert.equal((await readdir(worktree)).includes("repository"), false);

    await assert.rejects(
      () => cloneAzureDevOpsRepository(
        { repositoryName: metadata.name, destination: "nested\\repository" },
        {
          git: createNoopCloneGit(() => calls.push({ called: true })),
          getCredential: async () => { brokerCalls += 1; return "pat-secret-value"; },
          resolveRepository: async () => metadata,
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
    );
    assert.equal(calls.length, 0);
    assert.equal(brokerCalls, 0);
    assert.equal((await readdir(worktree)).includes("repository"), false);
  });
});

test("rejects a non-empty destination before broker or Git side effects", async () => {
  await withGitWorktree(async (worktree) => {
    const repositoryRoot = join(worktree, "repository");
    const destination = join(repositoryRoot, metadata.name);
    await mkdir(repositoryRoot);
    await mkdir(destination);
    await writeFile(join(destination, "keep.txt"), "keep");
    let brokerCalls = 0;
    let gitCalls = 0;

    await assert.rejects(
      cloneAzureDevOpsRepository(
        { repositoryName: metadata.name },
        {
          git: createNoopCloneGit(() => { gitCalls += 1; }),
          getCredential: async () => { brokerCalls += 1; return "pat-secret-value"; },
          resolveRepository: async () => metadata,
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_CONFLICT",
    );
    assert.equal(brokerCalls, 0);
    assert.equal(gitCalls, 0);
    assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "keep");
  });
});

test("rejects absolute, parent, and invalid destinations before Git side effects", async () => {
  await withGitWorktree(async (worktree) => {
    const destinations = ["/tmp/outside", "C:\\outside", "..\\outside", "../outside", "bad\0path", "."];
    let gitCalls = 0;
    for (const destination of destinations) {
      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryName: metadata.name, destination },
          {
            git: createNoopCloneGit(() => { gitCalls += 1; }),
            getCredential: async () => "pat-secret-value",
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => [
          "AZURE_DEVOPS_CLONE_DESTINATION_INVALID",
          "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
        ].includes(errorCode(error) ?? ""),
      );
    }
    assert.equal(gitCalls, 0);
    assert.equal((await readdir(worktree)).includes("repository"), false);
  });
});

test("rejects a symlink destination that escapes the current worktree", async () => {
  await withGitWorktree(async (worktree) => {
    const outside = await mkdtemp(join(tmpdir(), "azure-devops-clone-outside-"));
    const repositoryRoot = join(worktree, "repository");
    await mkdir(repositoryRoot);
    const link = join(repositoryRoot, "linked");
    try {
      try {
        await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      let gitCalls = 0;
      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryName: metadata.name, destination: "linked" },
          {
            git: createNoopCloneGit(() => { gitCalls += 1; }),
            getCredential: async () => "pat-secret-value",
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
      );
      assert.equal(gitCalls, 0);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("rejects a symlinked project repository directory before broker or Git side effects", async () => {
  await withGitWorktree(async (worktree) => {
    const outside = await mkdtemp(join(tmpdir(), "azure-devops-repository-root-outside-"));
    const repositoryRoot = join(worktree, "repository");
    let brokerCalls = 0;
    let gitCalls = 0;
    try {
      try {
        await symlink(outside, repositoryRoot, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      await assert.rejects(
        cloneAzureDevOpsRepository(
          { repositoryName: metadata.name },
          {
            git: createNoopCloneGit(() => { gitCalls += 1; }),
            getCredential: async () => { brokerCalls += 1; return "pat-secret-value"; },
            resolveRepository: async () => metadata,
            worktree,
          },
        ),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_DESTINATION_BOUNDARY",
      );

      assert.equal(brokerCalls, 0);
      assert.equal(gitCalls, 0);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("rejects credential-bearing canonical metadata and redacts Git failures", async () => {
  await withGitWorktree(async (worktree) => {
    const unsafeMetadata = { ...metadata, remoteUrl: `https://user:pat-secret-value@dev.azure.com/contoso/ado-project/_git/repository` };
    await assert.rejects(
      cloneAzureDevOpsRepository(
        { repositoryName: metadata.name },
        {
          git: createNoopCloneGit(() => { throw new Error("Git must not run"); }),
          getCredential: async () => "pat-secret-value",
          resolveRepository: async () => unsafeMetadata,
          worktree,
        },
      ),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_INVALID",
    );

    await assert.rejects(
      cloneAzureDevOpsRepository(
        { repositoryName: metadata.name },
        {
          git: createNoopCloneGit(() => { throw new Error(`Authorization: Bearer ${EXTENSION_SECRET} pat-secret-value`); }),
          getCredential: async () => "pat-secret-value",
          resolveRepository: async () => metadata,
          worktree,
        },
      ),
      (error: unknown) => {
        assert.equal(errorCode(error), "AZURE_DEVOPS_GIT_FAILED");
        assert.equal(errorMessage(error).includes("pat-secret-value"), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
  });
});

test("rejects non-canonical Azure DevOps remotes consistently", () => {
  const invalidRemoteUrls = [
    `${CANONICAL_REMOTE}/extra`,
    `https://user:password@dev.azure.com/contoso/ado-project/_git/repository`,
    `https://other@dev.azure.com/contoso/ado-project/_git/repository`,
    `https://contoso:@dev.azure.com/contoso/ado-project/_git/repository`,
    `${CANONICAL_REMOTE}?query=unexpected`,
    `${CANONICAL_REMOTE}#fragment`,
    "https://dev.azure.com:443/contoso/ado-project/_git/repository",
  ];
  for (const remoteUrl of invalidRemoteUrls) {
    assert.throws(
      () => validateAzureDevOpsRemoteUrl(remoteUrl, "contoso", "ado-project"),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_INVALID"
        && errorMessage(error) === "Azure DevOps remote URL is not canonical.",
    );
  }
});

test("normalizes documented organization-qualified and legacy Visual Studio clone URLs", () => {
  assert.equal(validateAzureDevOpsRemoteUrl(ORGANIZATION_QUALIFIED_REMOTE, "contoso", "ado-project"), CANONICAL_REMOTE);
  assert.equal(
    validateAzureDevOpsRemoteUrl("https://contoso.visualstudio.com/ado-project/_git/repository", "contoso", "ado-project"),
    CANONICAL_REMOTE,
  );
  assert.equal(
    validateAzureDevOpsRemoteUrl("https://contoso.visualstudio.com/DefaultCollection/ado-project/_git/repository", "contoso", "ado-project"),
    CANONICAL_REMOTE,
  );
});

test("push response verifies an organization-qualified observed URL by canonical identity", () => {
  const result = readPushResponse({
    branch: "main",
    organization: "contoso",
    project: "ado-project",
    remoteName: "origin",
    remoteUrl: CANONICAL_REMOTE,
    setUpstream: false,
    token: "pat-secret-value",
  }, ORGANIZATION_QUALIFIED_REMOTE);

  assert.equal(result.remoteUrl, CANONICAL_REMOTE);
  assert.equal(result.credential, "pat-secret-value");
});

test("pull response validates its resolved operation plan and canonical remote", () => {
  const plan = readPullPlanResponse({
    operationPlan: {
      parameters: {
        branch: "feature/pull",
        organization: "contoso",
        project: "ado-project",
        remoteName: "origin",
        repositoryPath: "repository/repository",
      },
      sources: {
        branch: "agent",
        organization: "derived",
        project: "fixed",
        remoteName: "fixed",
        repositoryPath: "agent",
      },
      tool: "azure_devops_git_pull",
    },
  });
  assert.equal(plan.repositoryPath, "repository/repository");
  assert.equal(plan.branch, "feature/pull");

  const resolution = readPullResponse({
    branch: "feature/pull",
    organization: "contoso",
    project: "ado-project",
    remoteName: "origin",
    remoteUrl: CANONICAL_REMOTE,
    token: "pat-secret-value",
  }, ORGANIZATION_QUALIFIED_REMOTE);
  assert.equal(resolution.remoteUrl, CANONICAL_REMOTE);
  assert.equal(resolution.credential, "pat-secret-value");

  assert.throws(
    () => readPullResponse({
      organization: "contoso",
      project: "ado-project",
      remoteName: "origin",
      remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository",
      token: "pat-secret-value",
    }, CANONICAL_REMOTE),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CANONICAL_REMOTE_MISMATCH",
  );
});

test("redacts PAT and extension secrets when Git fails before credential resolution", async () => {
  const previousEnvironment = {
    EXTENSION_SECRET_KEY: process.env.EXTENSION_SECRET_KEY,
    PERSONAL_ACCESS_TOKEN: process.env.PERSONAL_ACCESS_TOKEN,
  };
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET;
  process.env.PERSONAL_ACCESS_TOKEN = "pat-environment-value";
  try {
    await assert.rejects(
      () => pushAzureDevOpsWorktree(
        { branch: "main" },
        {
          git: {
            getRemoteUrl: async () => {
              throw new Error(`Git remote failed ${EXTENSION_SECRET} pat-environment-value`);
            },
            getPushRemoteUrls: async () => [CANONICAL_REMOTE],
            push: async () => undefined,
          },
          resolvePushPlan: async (input, derivedValues) => testPushPlan(input, derivedValues),
          resolvePush: async () => { throw new Error("must not resolve"); },
          worktree: "C:\\controlled\\worktree",
        },
      ),
      (error: unknown) => {
        assert.equal(errorCode(error), "AZURE_DEVOPS_GIT_PUSH_FAILED");
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        assert.equal(errorMessage(error).includes("pat-environment-value"), false);
        return true;
      },
    );
  } finally {
    restoreEnvironment("EXTENSION_SECRET_KEY", previousEnvironment.EXTENSION_SECRET_KEY);
    restoreEnvironment("PERSONAL_ACCESS_TOKEN", previousEnvironment.PERSONAL_ACCESS_TOKEN);
  }
});

function createFixtureCloneGit(source: string, calls: Array<Record<string, unknown>>) {
  const git = createAzureDevOpsGitOperations();
  return {
    ...git,
    async clone(input: Record<string, unknown>) {
      calls.push(input);
      const args = ["clone"];
      if (typeof input.branch === "string") args.push("--branch", input.branch);
      if (typeof input.ref === "string") args.push("--branch", input.ref.replace(/^refs\/(?:heads|tags)\//, ""));
      if (typeof input.depth === "number") args.push("--depth", String(input.depth));
      args.push(source, String(input.destination));
      await gitCommand(String(input.worktree), args);
      await gitCommand(String(input.destination), ["remote", "set-url", "origin", String(input.remoteUrl)]);
    },
  };
}

function createNoopCloneGit(onClone: () => void) {
  const git = createAzureDevOpsGitOperations();
  return {
    ...git,
    async clone(_input: Record<string, unknown>) {
      onClone();
    },
  };
}

async function withGitFixture(run: (fixture: { source: string; worktree: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "azure-devops-plugin-clone-"));
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  try {
    await mkdir(source);
    await mkdir(worktree);
    await gitCommand(source, ["init", "-b", "main"]);
    await gitCommand(source, ["config", "user.email", "fixture@example.test"]);
    await gitCommand(source, ["config", "user.name", "Fixture"]);
    await writeFile(join(source, "README.md"), "fixture\n");
    await gitCommand(source, ["add", "README.md"]);
    await gitCommand(source, ["commit", "-m", "fixture"]);
    await gitCommand(worktree, ["init"]);
    await run({ source, worktree });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withGitWorktree(run: (worktree: string) => Promise<void>): Promise<void> {
  const worktree = await mkdtemp(join(tmpdir(), "azure-devops-plugin-git-"));
  try {
    await git(worktree, ["init"]);
    await run(worktree);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, windowsHide: true });
  return String(result.stdout || "").trim();
}

const gitCommand = git;

async function gitConfig(cwd: string, key: string): Promise<string> {
  return git(cwd, ["config", "--local", "--get", key]);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function testPushPlan(input: Record<string, unknown>, derivedValues: Record<string, unknown>) {
  const branch = typeof input.branch === "string"
    ? input.branch
    : typeof derivedValues.branch === "string"
      ? derivedValues.branch
      : "main";
  const remoteName = typeof input.remoteName === "string" ? input.remoteName : "origin";
  const repositoryPath = typeof input.repositoryPath === "string" ? input.repositoryPath : "repository/test-repository";
  const setUpstream = input.setUpstream === true;
  return {
    branch,
    organization: "contoso",
    project: "ado-project",
    repositoryPath,
    remoteName,
    resolvedValues: { branch, organization: "contoso", project: "ado-project", repositoryPath, remoteName, setUpstream },
    setUpstream,
    sources: {
      branch: "agent",
      organization: "derived",
      project: "fixed",
      repositoryPath: typeof input.repositoryPath === "string" ? "agent" : "fixed",
      remoteName: "fixed",
      setUpstream: "agent",
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
