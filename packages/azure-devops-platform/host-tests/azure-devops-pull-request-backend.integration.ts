import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAzureDevOpsToolDefinitions } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import { jsonSchemaAccepts } from "./helpers/json-schema.ts";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";
import { ExtensionBackendService } from "../src/features/extensions/backend.js";
import { createDefaultAzureDevOpsParameterPolicy, resolveAzureDevOpsToolCall } from "../policy/index.ts";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const MANAGED_PROJECT = "managed-workspace";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const PAT = "pull-request-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
const TOOL = "azure_devops_create_pull_request";
const REVIEWER_IDS = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const WORK_ITEM_IDS = [74, 2_147_483_647];
const LABELS = ["release", "customer request"];
const SOURCE_REF = "refs/heads/feature/create-pr";
const TARGET_REF = "refs/heads/main";

test("creates a bounded pull request through the Plugin, BFF policy, credential boundary, and REST 7.1", async () => {
  await withBackend(async () => {
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    const fields = policy.tools[TOOL].fields;
    fields.repositoryReference = { mode: "fixed", value: `azure-devops://${ORGANIZATION}/${PROJECT}/${REPOSITORY_ID}` };
    fields.sourceRefName = { mode: "fixed", value: SOURCE_REF };
    fields.description = { mode: "fixed", value: "" };
    fields.supportsIterations = { mode: "fixed", value: true };
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    const adoRequests: Array<{ body?: unknown; headers: Headers; method: string; url: URL }> = [];
    let extensionSettingsProjectRead: string | undefined;
    const service = createBffService(policy, (project) => { extensionSettingsProjectRead = project; });
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-pull-request-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bffRequests.push({ body, headers, url });
        const path = url.pathname.split("/backend/")[1] ?? "";
        try {
          const { responseBody, status } = await runBffRequest(service, url, headers, path, body, method);
          return new Response(JSON.stringify(responseBody), { headers: { "content-type": "application/json" }, status });
        } catch (error) {
          return bffErrorResponse(error);
        }
      }

      adoRequests.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers,
        method,
        url,
      });
      if (method === "GET" && url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) {
        return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      }
      if (method === "GET" && url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)) {
        return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } }, 200);
      }
      if (method === "POST" && url.pathname.endsWith("/pullrequests")) {
        return jsonResponse({
          pullRequestId: 910,
          status: "active",
          title: "Create the deployment PR",
          sourceRefName: SOURCE_REF,
          targetRefName: TARGET_REF,
          isDraft: true,
          repository: { id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } },
          description: `raw response must not escape ${PAT}`,
          createdBy: { displayName: "unbounded identity payload" },
          _links: { web: { href: "https://untrusted.example/pr/910" } },
        }, 201);
      }
      throw new Error(`Unexpected REST request ${method} ${url.pathname}`);
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: MANAGED_PROJECT } as never) as unknown as Record<string, any>;
      assert.ok(plugin[TOOL]);
      assert.deepEqual(Object.keys(plugin[TOOL]!.input.properties).sort(), [
        "description", "isDraft", "labels", "project", "repositoryID", "repositoryName", "repositoryReference",
        "reviewerIds", "sourceRefName", "supportsIterations", "targetRefName", "title", "workItemIds",
      ].sort());
      const listSchemas = plugin[TOOL]!.input.properties;
      assert.equal(jsonSchemaAccepts(listSchemas.description, ""), true);
      assert.equal(jsonSchemaAccepts(listSchemas.description, "x".repeat(100_000)), true);
      assert.equal(jsonSchemaAccepts(listSchemas.description, "x".repeat(100_001)), false);
      assert.equal(jsonSchemaAccepts(listSchemas.reviewerIds, REVIEWER_IDS), true);
      assert.equal(jsonSchemaAccepts(listSchemas.workItemIds, WORK_ITEM_IDS), true);
      assert.equal(jsonSchemaAccepts(listSchemas.labels, LABELS), true);
      assert.equal(jsonSchemaAccepts(listSchemas.reviewerIds, ["invalid"]), false);
      assert.equal(jsonSchemaAccepts(listSchemas.workItemIds, [2_147_483_648]), false);
      assert.equal(jsonSchemaAccepts(listSchemas.labels, ["  "]), false);

      const result = await plugin[TOOL]!.execute({
        targetRefName: TARGET_REF,
        title: "Create the deployment PR",
        description: "",
        isDraft: true,
        reviewerIds: REVIEWER_IDS,
        workItemIds: WORK_ITEM_IDS,
        labels: LABELS,
      }, { metadata: async () => undefined });
      assert.equal(extensionSettingsProjectRead, MANAGED_PROJECT);
      assert.equal(bffRequests.length, 1);
      assert.equal(bffRequests[0]?.url.pathname, "/bff/extensions/azure-devops-platform/backend/create-pull-request");
      assert.equal(bffRequests[0]?.url.searchParams.get("project"), MANAGED_PROJECT);
      assert.equal(bffRequests[0]?.url.searchParams.get("scope"), "project");
      assert.equal(bffRequests[0]?.headers.get("x-agent-system-workspace"), MANAGED_PROJECT);
      assert.equal(bffRequests[0]?.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      assert.deepEqual(bffRequests[0]?.body, {
        tool: TOOL,
        agentInput: {
          targetRefName: TARGET_REF,
          title: "Create the deployment PR",
          description: "",
          isDraft: true,
          reviewerIds: REVIEWER_IDS,
          workItemIds: WORK_ITEM_IDS,
          labels: LABELS,
        },
      });

      assert.equal(adoRequests.length, 3);
      assert.equal(adoRequests.filter((request) => request.method === "POST").length, 1);
      assert.deepEqual(adoRequests.map(({ method, url }) => ({ method, pathname: url.pathname })), [
        { method: "GET", pathname: `/contoso/_apis/projects/${PROJECT}` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}` },
        { method: "POST", pathname: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullrequests` },
      ]);
      const createRequest = adoRequests[2]!;
      assert.equal(createRequest.url.searchParams.get("api-version"), "7.1");
      assert.equal(createRequest.url.searchParams.get("supportsIterations"), "true");
      assert.equal(createRequest.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(createRequest.body, {
        sourceRefName: SOURCE_REF,
        targetRefName: TARGET_REF,
        title: "Create the deployment PR",
        description: "",
        isDraft: true,
        completionOptions: { transitionWorkItems: true },
        reviewers: REVIEWER_IDS.map((id) => ({ id })),
        workItemRefs: WORK_ITEM_IDS.map((id) => ({ id: String(id) })),
        labels: LABELS.map((name) => ({ name })),
      });

      assert.deepEqual(JSON.parse(result.content), {
        id: 910,
        isDraft: true,
        repository: { id: REPOSITORY_ID, name: "api", project: PROJECT },
        sourceRefName: SOURCE_REF,
        status: "active",
        targetRefName: TARGET_REF,
        title: "Create the deployment PR",
      });
      for (const secretOrUnboundedValue of [PAT, EXTENSION_SECRET_KEY, "raw response must not escape", "unbounded identity payload", "untrusted.example"]) {
        assert.equal(result.content.includes(secretOrUnboundedValue), false);
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await service.close();
    }
  });
});

test("accepts the documented 200 success response and emits only the bounded PR projection", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, method, url });
      if (url.pathname.includes("/_apis/projects/")) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      if (url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)) {
        return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } }, 200);
      }
      return jsonResponse({
        pullRequestId: 911,
        status: "active",
        title: "No optional settings",
        sourceRefName: SOURCE_REF,
        targetRefName: TARGET_REF,
        isDraft: false,
        repository: { id: REPOSITORY_ID, name: "api" },
      }, 200);
    };

    try {
      const result = await callResolvedTool(runtime, { repositoryID: REPOSITORY_ID, sourceRefName: SOURCE_REF, targetRefName: TARGET_REF, title: "No optional settings" });
      assert.deepEqual(result, {
        id: 911,
        isDraft: false,
        repository: { id: REPOSITORY_ID, name: "api", project: PROJECT },
        sourceRefName: SOURCE_REF,
        status: "active",
        targetRefName: TARGET_REF,
        title: "No optional settings",
      });
      const create = calls.find((call) => call.method === "POST");
      assert.ok(create);
      assert.equal(create.url.searchParams.get("supportsIterations"), null);
      assert.deepEqual(create.body, { sourceRefName: SOURCE_REF, targetRefName: TARGET_REF, title: "No optional settings" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("backend rejects malformed PR list inputs before sending any Azure DevOps request", async () => {
  await withBackend(async (runtime) => {
    const invalidCases: Array<{ field: string; value: unknown; code: string }> = [
      { field: "reviewerIds", value: ["invalid"], code: "ADO_PULL_REQUEST_REVIEWER_IDS_INVALID" },
      { field: "reviewerIds", value: Array(51).fill(REVIEWER_IDS[0]), code: "ADO_PULL_REQUEST_REVIEWER_IDS_INVALID" },
      { field: "workItemIds", value: [0], code: "ADO_PULL_REQUEST_WORK_ITEM_IDS_INVALID" },
      { field: "workItemIds", value: [2_147_483_648], code: "ADO_PULL_REQUEST_WORK_ITEM_IDS_INVALID" },
      { field: "labels", value: ["  "], code: "ADO_PULL_REQUEST_LABELS_INVALID" },
      { field: "labels", value: ["x".repeat(129)], code: "ADO_PULL_REQUEST_LABELS_INVALID" },
      { field: "labels", value: Array(51).fill("label"), code: "ADO_PULL_REQUEST_LABELS_INVALID" },
      { field: "labels", value: Array(50).fill('"'.repeat(128)), code: "ADO_PULL_REQUEST_LISTS_TOO_LARGE" },
    ];
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new Error("Azure DevOps REST must not be called for invalid list input.");
    };
    try {
      for (const { field, value, code } of invalidCases) {
        await assert.rejects(
          () => callWithResolvedParameters(runtime, { [field]: value }),
          (error: unknown) => (error as { code?: unknown }).code === code
            && !(error as Error).message.includes(PAT)
            && !(error as Error).message.includes(EXTENSION_SECRET_KEY),
        );
      }
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("backend rejects an overlong pull request description before any Azure DevOps request", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new Error("Azure DevOps REST must not be called for an overlong description.");
    };
    try {
      await assert.rejects(
        () => callWithResolvedParameters(runtime, { description: "x".repeat(100_001) }),
        (error: unknown) => (error as { code?: unknown }).code === "ADO_PULL_REQUEST_DESCRIPTION_INVALID",
      );
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps bounded create failures and does not retry ambiguous outcomes", async () => {
  await withBackend(async (runtime) => {
    const failures = [
      { status: 400, code: "ADO_PULL_REQUEST_CREATE_FAILED", resultStatus: 400 },
      { status: 403, code: "ADO_PULL_REQUEST_PERMISSION_DENIED", resultStatus: 403 },
      { status: 409, code: "ADO_PULL_REQUEST_CONFLICT", resultStatus: 409 },
      { status: 500, code: "ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN", resultStatus: 502 },
      { status: 429, code: "ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN", resultStatus: 502 },
    ];
    const previousFetch = globalThis.fetch;
    try {
      for (const failure of failures) {
        let createCalls = 0;
        globalThis.fetch = async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname.includes("/_apis/projects/")) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
          if (url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)) {
            return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } }, 200);
          }
          createCalls += 1;
          assert.equal(init?.method, "POST");
          return jsonResponse({ message: `private upstream detail ${PAT}`, raw: { token: PAT } }, failure.status);
        };
        await assert.rejects(
          () => callResolvedTool(runtime, { repositoryID: REPOSITORY_ID, sourceRefName: SOURCE_REF, targetRefName: TARGET_REF, title: "Expected failure" }),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, failure.code);
            assert.equal((error as { statusCode?: unknown }).statusCode, failure.resultStatus);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes("private upstream detail"), false);
            if (failure.code === "ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN") assert.match((error as Error).message, /Verify the pull request.*before retrying/);
            return true;
          },
        );
        assert.equal(createCalls, 1, "a non-idempotent PR create request must never be automatically retried");
      }

      let posts = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/_apis/projects/")) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
        if (url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)) {
          return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } }, 200);
        }
        posts += 1;
        assert.equal(init?.method, "POST");
        throw new Error(`timeout after submission ${PAT}`);
      };
      await assert.rejects(
        () => callResolvedTool(runtime, { repositoryID: REPOSITORY_ID, sourceRefName: SOURCE_REF, targetRefName: TARGET_REF, title: "Timeout" }),
        (error: unknown) => (error as { code?: unknown }).code === "ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN"
          && !(error as Error).message.includes(PAT)
          && /Verify the pull request.*before retrying/.test((error as Error).message),
      );
      assert.equal(posts, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("treats an incomplete or mismatched 2xx response as an unknown create outcome", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/_apis/projects/")) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      if (url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)) {
        return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } }, 200);
      }
      return jsonResponse({
        pullRequestId: 912,
        status: "active",
        title: "Different server title",
        sourceRefName: SOURCE_REF,
        targetRefName: TARGET_REF,
        isDraft: false,
        repository: { id: REPOSITORY_ID, name: "api" },
      }, 201);
    };
    try {
      await assert.rejects(
        () => callResolvedTool(runtime, { repositoryID: REPOSITORY_ID, sourceRefName: SOURCE_REF, targetRefName: TARGET_REF, title: "Requested title" }),
        (error: unknown) => (error as { code?: unknown }).code === "ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN"
          && /Verify the pull request.*before retrying/.test((error as Error).message),
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

async function withBackend(run: (runtime: { handle: (input: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-pull-request-backend-"));
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET_KEY;
  process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
  try {
    const runtime = await activate() as { handle: (input: unknown) => Promise<unknown> };
    await runtime.handle({ request: {
      path: "store-credential",
      method: "POST",
      body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
      headers: {},
    } });
    await run(runtime);
  } finally {
    if (previousSecret === undefined) delete process.env.EXTENSION_SECRET_KEY;
    else process.env.EXTENSION_SECRET_KEY = previousSecret;
    if (previousStorePath === undefined) delete process.env.ADO_CREDENTIAL_STORE_PATH;
    else process.env.ADO_CREDENTIAL_STORE_PATH = previousStorePath;
    await rm(root, { force: true, recursive: true });
  }
}

function createBffService(policy: ReturnType<typeof createDefaultAzureDevOpsParameterPolicy>, onProjectRead: (project: string) => void): ExtensionBackendService {
  return new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "d".repeat(64),
        version: "1.6.46",
      }),
      readSettings: async (_extensionId: string, _scope: string, project: string) => {
        onProjectRead(project);
        return {
          azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy: policy },
        };
      },
    } as never,
    [],
  );
}

async function runBffRequest(
  service: ExtensionBackendService,
  url: URL,
  headers: Headers,
  path: string,
  body: Record<string, unknown>,
  method: string,
): Promise<{ responseBody: unknown; status: number }> {
  let status = 200;
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code(nextStatus: number) { status = nextStatus; return this; },
    header() { return this; },
    send(responseBody: unknown) { return responseBody; },
  };
  const responseBody = await service.handle({
    body,
    headers: Object.fromEntries(headers.entries()),
    method,
    params: { "*": path, extensionId: "azure-devops-platform" },
    query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
  } as never, reply as never);
  return { responseBody, status };
}

function bffErrorResponse(error: unknown): Response {
  const value = error as { code?: unknown; details?: unknown; message?: unknown; statusCode?: unknown };
  const status = typeof value.statusCode === "number" ? value.statusCode : 500;
  return new Response(JSON.stringify({ error: {
    code: typeof value.code === "string" ? value.code : "EXTENSION_BACKEND_REQUEST_FAILED",
    details: value.details,
    message: typeof value.message === "string" ? value.message : "Extension backend request failed.",
  } }), { headers: { "content-type": "application/json" }, status });
}

async function callResolvedTool(runtime: { handle: (input: unknown) => Promise<unknown> }, agentInput: Record<string, unknown>): Promise<unknown> {
  const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
  const resolvedToolCall = resolveAzureDevOpsToolCall(TOOL, policy, agentInput, { organization: ORGANIZATION });
  return callWithResolvedToolCall(runtime, resolvedToolCall, policy);
}

async function callWithResolvedParameters(
  runtime: { handle: (input: unknown) => Promise<unknown> },
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
  const resolvedToolCall = {
    parameters: {
      organization: ORGANIZATION,
      project: PROJECT,
      repositoryID: REPOSITORY_ID,
      sourceRefName: SOURCE_REF,
      targetRefName: TARGET_REF,
      title: "Validate list parameters",
      ...parameters,
    },
    sources: {},
    tool: TOOL,
  };
  return callWithResolvedToolCall(runtime, resolvedToolCall, policy);
}

async function callWithResolvedToolCall(
  runtime: { handle: (input: unknown) => Promise<unknown> },
  resolvedToolCall: unknown,
  policy: ReturnType<typeof createDefaultAzureDevOpsParameterPolicy>,
): Promise<unknown> {
  const response = await runtime.handle({ request: {
    path: "create-pull-request",
    method: "POST",
    body: {},
    headers: { "x-extension-secret-key": EXTENSION_SECRET_KEY },
    extensionContext: {
      azureDevOps: {
        effectiveContext: { organization: ORGANIZATION, adoProject: PROJECT, parameterPolicy: policy },
        resolvedToolCall,
      },
    },
  } });
  return (response as { body: unknown }).body;
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}
