import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const PIPELINE_ID = 42;
const RUN_ID = 57;
const PAT = "pipeline-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");

test("Pipeline preview uses Runs preview mode, returns bounded YAML, and never queues a run", async () => {
  await withBackend(async (runtime) => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requests.push({ body, headers: new Headers(init?.headers), method: init?.method ?? "GET", url: new URL(String(input)) });
      return new Response(JSON.stringify({
        id: RUN_ID,
        finalYaml: [
          "trigger: none",
          "variables:",
          "  - name: DB_PASSWORD",
          "    value: must-not-escape",
          "  - name: regular-variable-name",
          "    value: secret-literal-with-ordinary-name",
          "    isSecret: true",
          "  - name: second-ordinary-name",
          "    isSecret: true",
          "    value: second-secret-literal-with-ordinary-name",
          "  - name: public-variable-name",
          "    value: visible-variable-value",
          "    isSecret: false",
          "  - { name: flow-before, value: flow-secret-before, isSecret: true }",
          "  - { name: flow-after, isSecret: true, value: \"flow,secret,after\" }",
          "  - { name: flow-public, value: flow-public-value, isSecret: false }",
          "  - password: inline-secret-value",
          `  - comment: ${PAT}`,
          `  - metadata: ${EXTENSION_SECRET_KEY}`,
          "steps:",
          "  - script: echo safe",
        ].join("\n"),
        state: "unknown",
        variables: { accessToken: PAT },
        templateParameters: { password: "must-not-return" },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callTool(runtime, "preview-pipeline", "azure_devops_preview_pipeline", {
        pipelineId: PIPELINE_ID,
        branchRef: "refs/heads/release/2026",
        templateParameters: { environment: "staging", enabled: true, replicas: 3 },
      }) as { finalYaml: string; pipelineId: number; previewOnly: boolean; truncated: boolean };

      assert.deepEqual(requests.map(({ method, url }) => `${method} ${url.pathname}`), [
        "POST /contoso/ado-project/_apis/pipelines/42/runs",
      ]);
      assert.equal(requests[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(requests[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(requests[0]?.body, {
        previewRun: true,
        resources: { repositories: { self: { refName: "refs/heads/release/2026" } } },
        templateParameters: { environment: "staging", enabled: true, replicas: 3 },
      });
      assert.deepEqual(result, {
        pipelineId: PIPELINE_ID,
        previewOnly: true,
        finalYaml: [
          "trigger: none",
          "variables:",
          "  - name: DB_PASSWORD",
          "    value: [REDACTED]",
          "  - name: regular-variable-name",
          "    value: [REDACTED]",
          "    isSecret: true",
          "  - name: second-ordinary-name",
          "    isSecret: true",
          "    value: [REDACTED]",
          "  - name: public-variable-name",
          "    value: visible-variable-value",
          "    isSecret: false",
          "  - { name: flow-before, value: \"[REDACTED]\", isSecret: true }",
          "  - { name: flow-after, isSecret: true, value: \"[REDACTED]\" }",
          "  - { name: flow-public, value: flow-public-value, isSecret: false }",
          "  - password: [REDACTED]",
          "  - comment: [REDACTED]",
          "  - metadata: [REDACTED]",
          "steps:",
          "  - script: echo safe",
        ].join("\n"),
        truncated: false,
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET_KEY), false);
      assert.equal(JSON.stringify(result).includes("must-not-return"), false);
      assert.equal(JSON.stringify(result).includes("inline-secret-value"), false);
      assert.equal(JSON.stringify(result).includes("secret-literal-with-ordinary-name"), false);
      assert.equal(JSON.stringify(result).includes("second-secret-literal-with-ordinary-name"), false);
      assert.equal(JSON.stringify(result).includes("flow-secret-before"), false);
      assert.equal(JSON.stringify(result).includes("flow,secret,after"), false);
      assert.equal(result.finalYaml.includes("visible-variable-value"), true);
      assert.equal(result.finalYaml.includes("flow-public-value"), true);
      assert.equal(requests.length, 1, "preview uses only previewRun=true and performs no queue request");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Pipeline run queues only through the explicit run endpoint contract and returns bounded run identity", async () => {
  await withBackend(async (runtime) => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requests.push({ body, headers: new Headers(init?.headers), method: init?.method ?? "GET", url: new URL(String(input)) });
      return new Response(JSON.stringify({
        id: RUN_ID,
        name: "20261003.1",
        pipeline: { id: PIPELINE_ID, name: "Build and deploy", url: `https://dev.azure.com/${PAT}/must-not-return` },
        state: "inProgress",
        result: "unknown",
        createdDate: "2026-10-03T12:00:00Z",
        variables: { accessToken: PAT },
        templateParameters: { environment: "staging" },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callTool(runtime, "run-pipeline", "azure_devops_run_pipeline", {
        pipelineId: PIPELINE_ID,
        branchRef: "refs/heads/release/2026",
        templateParameters: { environment: "staging" },
      });
      assert.deepEqual(requests.map(({ method, url }) => `${method} ${url.pathname}`), [
        "POST /contoso/ado-project/_apis/pipelines/42/runs",
      ]);
      assert.equal(requests[0]?.url.searchParams.get("api-version"), "7.1");
      assert.deepEqual(requests[0]?.body, {
        previewRun: false,
        resources: { repositories: { self: { refName: "refs/heads/release/2026" } } },
        templateParameters: { environment: "staging" },
      });
      assert.deepEqual(result, {
        id: RUN_ID,
        pipelineId: PIPELINE_ID,
        pipelineName: "Build and deploy",
        name: "20261003.1",
        state: "inProgress",
        result: "unknown",
        createdDate: "2026-10-03T12:00:00Z",
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes("url"), false);
      assert.equal(JSON.stringify(result).includes("templateParameters"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Pipeline run status uses the official Get route and maps state/result without returning the REST payload", async () => {
  await withBackend(async (runtime) => {
    let requestURL: URL | undefined;
    let requestMethod: string | undefined;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requestURL = new URL(String(input));
      requestMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({
        id: RUN_ID,
        name: "20261003.1",
        pipeline: { id: PIPELINE_ID, name: "Build and deploy", folder: "\\release", revision: 8 },
        state: "completed",
        result: "failed",
        createdDate: "2026-10-03T12:00:00Z",
        finishedDate: "2026-10-03T12:03:00Z",
        variables: { secret: PAT },
        finalYaml: "must-not-return",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callTool(runtime, "get-pipeline-run", "azure_devops_get_pipeline_run", {
        pipelineId: PIPELINE_ID,
        runId: RUN_ID,
      });
      assert.equal(requestMethod, "GET");
      assert.equal(requestURL?.pathname, "/contoso/ado-project/_apis/pipelines/42/runs/57");
      assert.equal(requestURL?.searchParams.get("api-version"), "7.1");
      assert.deepEqual(result, {
        id: RUN_ID,
        pipelineId: PIPELINE_ID,
        pipelineName: "Build and deploy",
        name: "20261003.1",
        state: "completed",
        result: "failed",
        createdDate: "2026-10-03T12:00:00Z",
        finishedDate: "2026-10-03T12:03:00Z",
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes("must-not-return"), false);
      assert.equal(JSON.stringify(result).includes("folder"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Pipeline backend rejects structurally invalid template parameters before REST calls and bounds ambiguous run outcomes", async () => {
  await withBackend(async (runtime) => {
    let requests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({ message: `upstream echoed ${PAT} ${EXTENSION_SECRET_KEY}` }), { status: 500 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, "run-pipeline", "azure_devops_run_pipeline", {
          pipelineId: PIPELINE_ID,
          branchRef: "refs/heads/../main",
        }),
        (error: unknown) => isCodedError(error, "ADO_PIPELINE_BRANCH_REF_INVALID"),
      );
      await assert.rejects(
        () => callTool(runtime, "run-pipeline", "azure_devops_run_pipeline", {
          pipelineId: PIPELINE_ID,
          templateParameters: { nested: { value: "not-a-scalar" } },
        }),
        (error: unknown) => isCodedError(error, "ADO_PIPELINE_TEMPLATE_PARAMETERS_INVALID"),
      );
      assert.equal(requests, 0);

      await assert.rejects(
        () => callTool(runtime, "run-pipeline", "azure_devops_run_pipeline", { pipelineId: PIPELINE_ID }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_PIPELINE_RUN_OUTCOME_UNKNOWN"), true);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal((error as Error).message.includes(EXTENSION_SECRET_KEY), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(EXTENSION_SECRET_KEY), false);
          return true;
        },
      );
      assert.equal(requests, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

async function withBackend(run: (runtime: { handle: (input: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-pipeline-backend-"));
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

async function callTool(
  runtime: { handle: (input: unknown) => Promise<unknown> },
  path: "preview-pipeline" | "run-pipeline" | "get-pipeline-run",
  tool: "azure_devops_preview_pipeline" | "azure_devops_run_pipeline" | "azure_devops_get_pipeline_run",
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const response = await runtime.handle({ request: {
    path,
    method: "POST",
    body: {},
    headers: { "x-extension-secret-key": EXTENSION_SECRET_KEY },
    extensionContext: {
      azureDevOps: {
        effectiveContext: {
          organization: ORGANIZATION,
          adoProject: PROJECT,
          parameterPolicy: { tools: { [tool]: { fields: { project: { mode: "fixed", value: PROJECT } } } } },
        },
        resolvedToolCall: {
          tool,
          parameters: { organization: ORGANIZATION, project: PROJECT, ...parameters },
        },
      },
    },
  } });
  return (response as { body: unknown }).body;
}

function isCodedError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
