import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAzureDevOpsToolDefinitions } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import { jsonSchemaAccepts } from "./helpers/json-schema.ts";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";
import { ExtensionBackendService } from "../src/features/extensions/backend.js";
import { createDefaultAzureDevOpsParameterPolicy } from "../policy/index.ts";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const MANAGED_PROJECT = "managed-workspace";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const PAT = "pull-request-read-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 8).toString("base64");
const SOURCE_COMMIT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_COMMIT_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_COMMIT_ID = "cccccccccccccccccccccccccccccccccccccccc";
const PAGE_ONE_COMMIT_ID = "dddddddddddddddddddddddddddddddddddddddd";
const PAGE_TWO_COMMIT_ID = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NEXT_TOKEN = "page-2+/=";

test("gets a project-scoped pull request and bounded commit pages through Plugin, BFF, Extension backend, and mocked REST", async () => {
  await withHarness(async ({ service, tool }) => {
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    const adoRequests: Array<{ headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    let unsafePullRequestTitle: string | undefined;
    let unsafeCommitMessage: string | undefined;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-get-pull-request-bff.test";
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
          return jsonResponse(responseBody, status);
        } catch (error) {
          return bffErrorResponse(error);
        }
      }

      adoRequests.push({ headers, method, url });
      assert.equal(headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      if (method === "GET" && url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) {
        return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      }
      if (method === "GET" && url.pathname.endsWith("/_apis/git/pullrequests/910")) {
        const pullRequest = pullRequestResponse();
        if (unsafePullRequestTitle !== undefined) pullRequest.title = unsafePullRequestTitle;
        return jsonResponse(pullRequest, 200);
      }
      if (method === "GET" && url.pathname.endsWith(`/pullRequests/910/commits`)) {
        assert.equal(url.searchParams.get("api-version"), "7.1");
        const top = url.searchParams.get("$top");
        const continuationToken = url.searchParams.get("continuationToken");
        if (top === "50") {
          assert.equal(continuationToken, null);
          return jsonResponse({ count: 0, value: [] }, 200);
        }
        assert.equal(top, "1");
        if (continuationToken === null) {
          if (unsafeCommitMessage !== undefined) {
            return jsonResponse({ count: 1, value: [commit(PAGE_ONE_COMMIT_ID, unsafeCommitMessage)] }, 200);
          }
          return jsonResponse({ count: 1, value: [commit(PAGE_ONE_COMMIT_ID, "Add the request handler")] }, 200, {
            "x-ms-continuationtoken": NEXT_TOKEN,
          });
        }
        assert.equal(continuationToken, NEXT_TOKEN);
        return jsonResponse({ count: 1, value: [commit(PAGE_TWO_COMMIT_ID, "z".repeat(2_001))] }, 200);
      }
      throw new Error(`Unexpected REST request ${method} ${url.pathname}`);
    };

    try {
      assert.deepEqual(Object.keys(tool.input.properties).sort(), ["commitContinuationToken", "commitTop", "project", "pullRequestId"].sort());
      assert.equal(jsonSchemaAccepts(tool.input.properties.pullRequestId, 2_147_483_647), true);
      assert.equal(jsonSchemaAccepts(tool.input.properties.pullRequestId, 0), false);
      assert.equal(jsonSchemaAccepts(tool.input.properties.commitTop, 100), true);
      assert.equal(jsonSchemaAccepts(tool.input.properties.commitTop, 101), false);
      assert.equal(jsonSchemaAccepts(tool.input.properties.commitContinuationToken, NEXT_TOKEN), true);
      assert.equal(jsonSchemaAccepts(tool.input.properties.commitContinuationToken, "x".repeat(2_001)), false);

      const firstResult = await tool.execute({ pullRequestId: 910, commitTop: 1 }, { metadata: async () => undefined });
      assert.deepEqual(JSON.parse(firstResult.content), {
        id: 910,
        status: "active",
        title: "Inspect deployment readiness",
        sourceRefName: "refs/heads/feature/get-pr-details",
        targetRefName: "refs/heads/main",
        repository: { id: REPOSITORY_ID, name: "api", project: PROJECT },
        sourceCommitId: SOURCE_COMMIT_ID,
        targetCommitId: TARGET_COMMIT_ID,
        lastMergeCommitId: MERGE_COMMIT_ID,
        commitTop: 1,
        commits: [{
          commitId: PAGE_ONE_COMMIT_ID,
          message: "Add the request handler",
          messageTruncated: false,
          authorName: "Ada Developer",
          authorDate: "2026-10-06T10:00:00.000Z",
        }],
        nextContinuationToken: NEXT_TOKEN,
      });

      const secondResult = await tool.execute({
        pullRequestId: 910,
        commitTop: 1,
        commitContinuationToken: NEXT_TOKEN,
      }, { metadata: async () => undefined });
      const secondOutput = JSON.parse(secondResult.content) as Record<string, unknown>;
      const secondCommit = (secondOutput.commits as Array<Record<string, unknown>>)[0];
      assert.equal(secondCommit?.commitId, PAGE_TWO_COMMIT_ID);
      assert.equal((secondCommit?.message as string).length, 2_000);
      assert.equal(secondCommit?.messageTruncated, true);
      assert.equal(secondCommit?.authorName, "Ada Developer");
      assert.equal(secondCommit?.authorDate, "2026-10-06T10:00:00.000Z");
      assert.equal(secondOutput.nextContinuationToken, undefined);

      const defaultPageResult = await tool.execute({ pullRequestId: 910 }, { metadata: async () => undefined });
      const defaultPage = JSON.parse(defaultPageResult.content) as Record<string, unknown>;
      assert.equal(defaultPage.commitTop, 50);
      assert.deepEqual(defaultPage.commits, []);
      assert.equal(defaultPage.nextContinuationToken, undefined);

      assert.equal(bffRequests.length, 3);
      for (const request of bffRequests) {
        assert.equal(request.url.pathname, "/bff/extensions/azure-devops-platform/backend/get-pull-request");
        assert.equal(request.url.searchParams.get("project"), MANAGED_PROJECT);
        assert.equal(request.url.searchParams.get("scope"), "project");
        assert.equal(request.headers.get("x-agent-system-workspace"), MANAGED_PROJECT);
        assert.equal(request.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      }
      assert.deepEqual(bffRequests[0]?.body, {
        tool: "azure_devops_get_pull_request",
        agentInput: { pullRequestId: 910, commitTop: 1 },
      });
      assert.deepEqual(bffRequests[1]?.body, {
        tool: "azure_devops_get_pull_request",
        agentInput: { pullRequestId: 910, commitTop: 1, commitContinuationToken: NEXT_TOKEN },
      });
      assert.deepEqual(bffRequests[2]?.body, {
        tool: "azure_devops_get_pull_request",
        agentInput: { pullRequestId: 910 },
      });

      assert.equal(adoRequests.length, 9);
      assert.deepEqual(adoRequests.map(({ method, url }) => ({ method, pathname: url.pathname })), [
        { method: "GET", pathname: `/contoso/_apis/projects/${PROJECT}` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/pullrequests/910` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/910/commits` },
        { method: "GET", pathname: `/contoso/_apis/projects/${PROJECT}` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/pullrequests/910` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/910/commits` },
        { method: "GET", pathname: `/contoso/_apis/projects/${PROJECT}` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/pullrequests/910` },
        { method: "GET", pathname: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullRequests/910/commits` },
      ]);
      assert.equal(adoRequests[1]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(adoRequests[2]?.url.searchParams.get("$top"), "1");
      assert.equal(adoRequests[5]?.url.searchParams.get("continuationToken"), NEXT_TOKEN);
      assert.equal(adoRequests[8]?.url.searchParams.get("$top"), "50");

      for (const secretOrUnboundedValue of [PAT, EXTENSION_SECRET_KEY, "private upstream detail", "private@example.invalid", "untrusted.example"]) {
        assert.equal(firstResult.content.includes(secretOrUnboundedValue), false);
        assert.equal(secondResult.content.includes(secretOrUnboundedValue), false);
        assert.equal(defaultPageResult.content.includes(secretOrUnboundedValue), false);
      }

      for (const unsafeValue of credentialVariants(PAT, EXTENSION_SECRET_KEY)) {
        unsafePullRequestTitle = `private PR title ${unsafeValue}`;
        await assert.rejects(
          () => tool.execute({ pullRequestId: 910, commitTop: 1 }, { metadata: async () => undefined }),
          (error: unknown) => {
            assert.equal((error as Error).message.includes(unsafeValue), false);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes(EXTENSION_SECRET_KEY), false);
            return true;
          },
        );
        unsafePullRequestTitle = undefined;

        unsafeCommitMessage = `private commit message ${unsafeValue}`;
        await assert.rejects(
          () => tool.execute({ pullRequestId: 910, commitTop: 1 }, { metadata: async () => undefined }),
          (error: unknown) => {
            assert.equal((error as Error).message.includes(unsafeValue), false);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes(EXTENSION_SECRET_KEY), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(unsafeValue), false);
            return true;
          },
        );
        unsafeCommitMessage = undefined;
      }
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
    }
  });
});

test("rejects invalid PR IDs before REST and returns a bounded not-found diagnostic", async () => {
  await withHarness(async ({ service, tool }) => {
    const adoRequests: URL[] = [];
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-get-pull-request-errors.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const path = url.pathname.split("/backend/")[1] ?? "";
        try {
          const { responseBody, status } = await runBffRequest(service, url, headers, path, body, init?.method ?? "GET");
          return jsonResponse(responseBody, status);
        } catch (error) {
          return bffErrorResponse(error);
        }
      }
      adoRequests.push(url);
      if (url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      return jsonResponse({ message: `private upstream detail ${PAT}` }, 404);
    };

    try {
      await assert.rejects(
        () => tool.execute({ pullRequestId: 0 }, { metadata: async () => undefined }),
        (error: unknown) => (error as { code?: unknown }).code === "AZURE_DEVOPS_AGENT_PARAMETER_INVALID"
          && !(error as Error).message.includes(PAT),
      );
      assert.equal(adoRequests.length, 0);

      await assert.rejects(
        () => tool.execute({ pullRequestId: 910 }, { metadata: async () => undefined }),
        (error: unknown) => (error as { code?: unknown }).code === "ADO_PULL_REQUEST_NOT_FOUND"
          && !(error as Error).message.includes(PAT)
          && !(error as Error).message.includes("private upstream detail"),
      );
      assert.deepEqual(adoRequests.map((url) => url.pathname), [
        `/contoso/_apis/projects/${PROJECT}`,
        `/contoso/${PROJECT}/_apis/git/pullrequests/910`,
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
    }
  });
});

test("maps PR permission and upstream failures safely and rejects a Repository from another Project", async () => {
  await withHarness(async ({ service, tool }) => {
    const adoRequests: URL[] = [];
    let responseMode: "forbidden" | "server-error" | "cross-project" = "forbidden";
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-get-pull-request-response-errors.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const path = url.pathname.split("/backend/")[1] ?? "";
        try {
          const { responseBody, status } = await runBffRequest(service, url, headers, path, body, init?.method ?? "GET");
          return jsonResponse(responseBody, status);
        } catch (error) {
          return bffErrorResponse(error);
        }
      }
      adoRequests.push(url);
      if (url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) return jsonResponse({ id: PROJECT_ID, name: PROJECT }, 200);
      if (responseMode === "forbidden") return jsonResponse({ message: `private permission detail ${PAT}` }, 403);
      if (responseMode === "server-error") return jsonResponse({ message: `private server detail ${PAT}` }, 503);
      const mismatched = pullRequestResponse();
      mismatched.repository = {
        id: REPOSITORY_ID,
        name: "api",
        project: { id: "99999999-9999-4999-8999-999999999999", name: "other-project" },
      };
      return jsonResponse(mismatched, 200);
    };

    try {
      for (const failure of [
        { mode: "forbidden" as const, code: "ADO_PULL_REQUEST_PERMISSION_DENIED" },
        { mode: "server-error" as const, code: "ADO_PULL_REQUEST_GET_FAILED" },
        { mode: "cross-project" as const, code: "ADO_PULL_REQUEST_PROJECT_MISMATCH" },
      ]) {
        responseMode = failure.mode;
        await assert.rejects(
          () => tool.execute({ pullRequestId: 910 }, { metadata: async () => undefined }),
          (error: unknown) => (error as { code?: unknown }).code === failure.code
            && !(error as Error).message.includes(PAT)
            && !(error as Error).message.includes("private permission detail")
            && !(error as Error).message.includes("private server detail"),
        );
      }
      assert.equal(adoRequests.length, 6);
      assert.equal(adoRequests.filter((url) => url.pathname.endsWith("/commits")).length, 0);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
    }
  });
});

async function withHarness(run: (input: {
  service: ExtensionBackendService;
  tool: PluginTool;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-get-pull-request-backend-"));
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET_KEY;
  process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
  let service: ExtensionBackendService | undefined;
  try {
    const backendRuntime = await activate() as { handle: (input: unknown) => Promise<unknown> };
    await backendRuntime.handle({ request: {
      path: "store-credential",
      method: "POST",
      body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
      headers: {},
    } });
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    service = createBffService(policy);
    const plugin = await createAzureDevOpsToolDefinitions({ project: MANAGED_PROJECT } as never) as unknown as Record<string, any>;
    const tool = plugin.azure_devops_get_pull_request;
    assert.ok(tool);
    await run({ service, tool });
  } finally {
    if (previousSecret === undefined) delete process.env.EXTENSION_SECRET_KEY;
    else process.env.EXTENSION_SECRET_KEY = previousSecret;
    if (previousStorePath === undefined) delete process.env.ADO_CREDENTIAL_STORE_PATH;
    else process.env.ADO_CREDENTIAL_STORE_PATH = previousStorePath;
    await service?.close();
    await rm(root, { force: true, recursive: true });
  }
}

type PluginTool = {
  input: { type: "object"; properties: Record<string, unknown> };
  execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
};

function createBffService(policy: ReturnType<typeof createDefaultAzureDevOpsParameterPolicy>): ExtensionBackendService {
  return new ExtensionBackendService(
    {
      readBackend: async () => ({
        content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
        effectiveScope: "project",
        extensionId: "azure-devops-platform",
        packageSha256: "e".repeat(64),
        version: "1.6.46",
      }),
      readSettings: async () => ({
        azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy: policy },
      }),
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
  return jsonResponse({ error: {
    code: typeof value.code === "string" ? value.code : "EXTENSION_BACKEND_REQUEST_FAILED",
    details: value.details,
    message: typeof value.message === "string" ? value.message : "Extension backend request failed.",
  } }, status);
}

function pullRequestResponse(): Record<string, unknown> {
  return {
    pullRequestId: 910,
    status: "active",
    title: "Inspect deployment readiness",
    sourceRefName: "refs/heads/feature/get-pr-details",
    targetRefName: "refs/heads/main",
    repository: { id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } },
    lastMergeSourceCommit: { commitId: SOURCE_COMMIT_ID },
    lastMergeTargetCommit: { commitId: TARGET_COMMIT_ID },
    lastMergeCommit: { commitId: MERGE_COMMIT_ID },
    description: `unbounded details must not escape ${PAT}`,
    createdBy: { displayName: "unbounded identity payload", uniqueName: "private@example.invalid" },
    _links: { web: { href: "https://untrusted.example/pullrequest/910" } },
  };
}

function commit(commitId: string, comment: string): Record<string, unknown> {
  return {
    commitId,
    comment,
    commentTruncated: false,
    author: {
      name: "Ada Developer",
      email: "private@example.invalid",
      date: "2026-10-06T10:00:00.000Z",
    },
    url: "https://untrusted.example/commit",
    parents: ["raw-parent-payload"],
  };
}

function jsonResponse(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers }, status });
}

function credentialVariants(pat: string, extensionSecret: string): string[] {
  const extensionSecretBase64 = Buffer.from(extensionSecret, "utf8").toString("base64");
  const decodedExtensionSecret = Buffer.from(extensionSecret, "base64");
  const decodedExtensionSecretHex = decodedExtensionSecret.toString("hex");
  return [
    pat,
    Buffer.from(pat, "utf8").toString("base64"),
    Buffer.from(`:${pat}`, "utf8").toString("base64"),
    extensionSecret,
    encodeURIComponent(extensionSecret),
    encodeURIComponent(extensionSecret).replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
    extensionSecretBase64,
    extensionSecretBase64.replace(/=+$/, ""),
    extensionSecretBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    Buffer.from(extensionSecret, "utf8").toString("hex"),
    Buffer.from(extensionSecret, "utf8").toString("hex").toUpperCase(),
    decodedExtensionSecretHex,
    decodedExtensionSecretHex.toUpperCase(),
    decodedExtensionSecret.toString("latin1"),
  ];
}
