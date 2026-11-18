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
const PAT = "pull-request-list-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
const SOURCE_COMMIT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_COMMIT_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MERGE_COMMIT_ID = "cccccccccccccccccccccccccccccccccccccccc";
const SOURCE_REF = "refs/heads/feature/preflight";
const TARGET_REF = "refs/heads/main";

test("lists bounded pull request summaries through Plugin, BFF policy, and the mocked REST boundary", async () => {
  await withBffBackend(async (bff) => {
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    const adoRequests: Array<{ headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    let summaryTitle = "Existing feature PR";
    let sourceCommitReference: unknown = { commitId: SOURCE_COMMIT_ID };
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-pr-list-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bffRequests.push({ body, headers, url });
        const path = url.pathname.split("/backend/")[1] ?? "";
        try {
          const result = await runBffRequest(bff, url, headers, path, body, method);
          return new Response(JSON.stringify(result.body), { headers: { "content-type": "application/json" }, status: result.status });
        } catch (error) {
          const value = error as { code?: unknown; message?: unknown; statusCode?: unknown };
          return new Response(JSON.stringify({ error: {
            code: value.code ?? "EXTENSION_BACKEND_REQUEST_FAILED",
            message: value.message ?? "Extension backend request failed.",
          } }), { headers: { "content-type": "application/json" }, status: typeof value.statusCode === "number" ? value.statusCode : 500 });
        }
      }

      adoRequests.push({ headers, method, url });
      if (method === "GET" && url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) {
        return jsonResponse({ id: PROJECT_ID, name: PROJECT });
      }
      if (method === "GET" && (url.pathname.endsWith("/_apis/git/repositories/api")
        || url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`))) {
        return jsonResponse({ id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } });
      }
      if (method === "GET" && url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}/pullrequests`)) {
        if (url.searchParams.get("searchCriteria.status") === "all") return jsonResponse({ count: 0, value: [] });
        return jsonResponse({
          count: 1,
          value: [{
            pullRequestId: 910,
            status: "active",
            title: summaryTitle,
            sourceRefName: SOURCE_REF,
            targetRefName: TARGET_REF,
            lastMergeSourceCommit: sourceCommitReference,
            lastMergeTargetCommit: { commitId: TARGET_COMMIT_ID },
            lastMergeCommit: { commitId: MERGE_COMMIT_ID },
            repository: { id: REPOSITORY_ID, name: "api", project: { id: PROJECT_ID, name: PROJECT } },
            description: `must not be returned ${PAT}`,
            createdBy: { displayName: "private identity payload" },
            _links: { web: { href: "https://untrusted.invalid/pull/910" } },
          }],
        });
      }
      throw new Error(`Unexpected REST request ${method} ${url.pathname}`);
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: MANAGED_PROJECT } as never) as unknown as Record<string, any>;
      const listTool = plugin.azure_devops_list_pull_requests;
      assert.ok(listTool);
      const createToolDescription = plugin.azure_devops_create_pull_request?.description ?? "";
      assert.match(createToolDescription, /azure_devops_list_pull_requests/);
      assert.match(createToolDescription, /status active/);
      assert.match(createToolDescription, /do not call this create tool/);
      assert.match(createToolDescription, /does not guarantee atomic uniqueness across concurrent requests/);
      assert.deepEqual(Object.keys(listTool.input.properties).sort(), [
        "project", "repositoryID", "repositoryName", "repositoryReference", "skip", "sourceRefName", "status", "targetRefName", "top",
      ].sort());
      const schemas = listTool.input.properties;
      assert.equal(jsonSchemaAccepts(schemas.status, "all"), true);
      assert.equal(jsonSchemaAccepts(schemas.top, 100), true);
      assert.equal(jsonSchemaAccepts(schemas.skip, 0), true);
      assert.equal(jsonSchemaAccepts(schemas.status, "not-a-status"), false);
      assert.equal(jsonSchemaAccepts(schemas.top, 101), false);
      assert.equal(jsonSchemaAccepts(schemas.skip, -1), false);

      const activeResult = await listTool.execute({
        repositoryName: "api",
        sourceRefName: SOURCE_REF,
        targetRefName: TARGET_REF,
      }, { metadata: async () => undefined });
      assert.deepEqual(JSON.parse(activeResult.content), {
        count: 1,
        pullRequests: [{
          id: 910,
          repository: { id: REPOSITORY_ID, name: "api", project: PROJECT },
          sourceRefName: SOURCE_REF,
          sourceCommitId: SOURCE_COMMIT_ID,
          status: "active",
          targetRefName: TARGET_REF,
          targetCommitId: TARGET_COMMIT_ID,
          lastMergeCommitId: MERGE_COMMIT_ID,
          title: "Existing feature PR",
        }],
        skip: 0,
        status: "active",
        top: 50,
      });
      for (const privateValue of [PAT, EXTENSION_SECRET_KEY, "private identity payload", "untrusted.invalid"]) {
        assert.equal(activeResult.content.includes(privateValue), false);
      }

      const allResult = await listTool.execute({ repositoryID: REPOSITORY_ID, status: "all", top: 100, skip: 17 }, { metadata: async () => undefined });
      assert.deepEqual(JSON.parse(allResult.content), { count: 0, pullRequests: [], skip: 17, status: "all", top: 100 });
      assert.equal(bffRequests.length, 2);
      assert.equal(bffRequests[0]?.url.pathname, "/bff/extensions/azure-devops-platform/backend/list-pull-requests");
      assert.equal(bffRequests[0]?.url.searchParams.get("project"), MANAGED_PROJECT);
      assert.equal(bffRequests[0]?.url.searchParams.get("scope"), "project");
      assert.equal(bffRequests[0]?.headers.get("x-agent-system-workspace"), MANAGED_PROJECT);
      assert.equal(bffRequests[0]?.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      assert.deepEqual(bffRequests[0]?.body, {
        tool: "azure_devops_list_pull_requests",
        agentInput: { repositoryName: "api", sourceRefName: SOURCE_REF, targetRefName: TARGET_REF },
      });

      const listRequests = adoRequests.filter((request) => request.url.pathname.endsWith("/pullrequests"));
      assert.equal(adoRequests.filter((request) => request.method !== "GET").length, 0);
      assert.equal(listRequests.length, 2);
      assert.deepEqual(listRequests.map(({ url }) => ({
        apiVersion: url.searchParams.get("api-version"),
        path: url.pathname,
        skip: url.searchParams.get("$skip"),
        source: url.searchParams.get("searchCriteria.sourceRefName"),
        status: url.searchParams.get("searchCriteria.status"),
        target: url.searchParams.get("searchCriteria.targetRefName"),
        top: url.searchParams.get("$top"),
      })), [
        {
          apiVersion: "7.1",
          path: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullrequests`,
          skip: "0",
          source: SOURCE_REF,
          status: "active",
          target: TARGET_REF,
          top: "50",
        },
        {
          apiVersion: "7.1",
          path: `/contoso/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pullrequests`,
          skip: "17",
          source: null,
          status: "all",
          target: null,
          top: "100",
        },
      ]);
      assert.equal(listRequests.every((request) => request.headers.get("authorization") === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`), true);

      for (const unsafeValue of credentialVariants(PAT, EXTENSION_SECRET_KEY)) {
        summaryTitle = `private upstream text ${unsafeValue}`;
        await assert.rejects(
          () => listTool.execute({ repositoryName: "api" }, { metadata: async () => undefined }),
          (error: unknown) => {
            assert.equal((error as Error).message.includes(unsafeValue), false);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes(EXTENSION_SECRET_KEY), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(unsafeValue), false);
            return true;
          },
        );
      }

      summaryTitle = "Existing feature PR";
      sourceCommitReference = { commitId: "not-a-git-object-id" };
      await assert.rejects(
        () => listTool.execute({ repositoryName: "api" }, { metadata: async () => undefined }),
        (error: unknown) => {
          assert.equal((error as Error).message.includes("not-a-git-object-id"), false);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await bff.close();
    }
  });
});

async function withBffBackend(run: (service: ExtensionBackendService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-pull-request-list-"));
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
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    const service = new ExtensionBackendService(
      {
        readBackend: async () => ({
          content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
          effectiveScope: "project",
          extensionId: "azure-devops-platform",
          packageSha256: "e".repeat(64),
          version: "1.6.46",
        }),
        readSettings: async () => ({ azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy: policy } }),
      } as never,
      [],
    );
    try {
      await run(service);
    } finally {
      await service.close();
    }
  } finally {
    if (previousSecret === undefined) delete process.env.EXTENSION_SECRET_KEY;
    else process.env.EXTENSION_SECRET_KEY = previousSecret;
    if (previousStorePath === undefined) delete process.env.ADO_CREDENTIAL_STORE_PATH;
    else process.env.ADO_CREDENTIAL_STORE_PATH = previousStorePath;
    await rm(root, { force: true, recursive: true });
  }
}

async function runBffRequest(
  service: ExtensionBackendService,
  url: URL,
  headers: Headers,
  path: string,
  body: Record<string, unknown>,
  method: string,
): Promise<{ body: unknown; status: number }> {
  let status = 200;
  const reply = {
    raw: { headersSent: false, writableEnded: false },
    sent: false,
    code(nextStatus: number) { status = nextStatus; return this; },
    header() { return this; },
    send(body: unknown) { return body; },
  };
  const responseBody = await service.handle({
    body,
    headers: Object.fromEntries(headers.entries()),
    method,
    params: { "*": path, extensionId: "azure-devops-platform" },
    query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
  } as never, reply as never);
  return { body: responseBody, status };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status: 200 });
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
