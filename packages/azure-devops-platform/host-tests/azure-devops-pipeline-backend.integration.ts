import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createDefaultAzureDevOpsParameterPolicy,
  resolveAzureDevOpsToolCall,
} from "../policy/index.ts";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";
import { createAzureDevOpsToolDefinitions } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import {
  readAzureDevOpsPipelineCreateResponse,
  readAzureDevOpsPipelineListResponse,
} from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/tools/pipeline.ts";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const PAT = "pat-secret-value";
const EXTENSION_SECRET = "extension-secret-value";
const YAML_PATH = "/pipelines/ci.yml";

test("lists a bounded Pipeline page through REST 7.1 and forwards the continuation token", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    const result = await call("list-pipelines", "azure_devops_list_pipelines", { continuationToken: "page-2+/=" });

    assert.deepEqual(requests.map(({ method, url }) => ({ method, url: url.toString() })), [
      {
        method: "GET",
        url: `https://dev.azure.com/${ORGANIZATION}/_apis/projects/${PROJECT}?api-version=7.1`,
      },
      {
        method: "GET",
        url: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/pipelines?%24top=100&api-version=7.1&continuationToken=page-2%2B%2F%3D`,
      },
    ]);
    assert.deepEqual(result.body, {
      count: 1,
      pipelines: [{ id: 17, name: "CI", folder: "\\Build" }],
      continuationToken: "page-3",
    });
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
    assert.equal(requests[1]?.authorization, `Basic ${Buffer.from(`:${PAT}`, "utf8").toString("base64")}`);
  }, async (url) => {
    if (url.pathname.endsWith("/_apis/pipelines")) {
      assert.equal(url.searchParams.get("continuationToken"), "page-2+/=");
      return response(200, [{ id: 17, name: "CI", folder: "\\Build" }], {
        "x-ms-continuationtoken": "page-3",
      });
    }
    return projectResponse(url);
  });
});

test("rejects malformed Pipeline list responses and returns safe permission diagnostics", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("list-pipelines", "azure_devops_list_pipelines", {}),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_LIST_RESPONSE_INVALID",
    );
    assert.equal(requests.length, 2);
  }, async (url) => url.pathname.endsWith("/_apis/pipelines")
    ? response(200, { count: 0, value: "not-an-array" })
    : projectResponse(url));

  await withPipelineBackend(async ({ call }) => {
    await assert.rejects(
      () => call("list-pipelines", "azure_devops_list_pipelines", {}),
      (error: unknown) => {
        assert.equal(errorCode(error), "ADO_PIPELINE_PERMISSION_DENIED");
        assert.equal((error as { statusCode?: number }).statusCode, 403);
        assert.equal((error as { details?: Record<string, unknown> }).details?.upstreamStatus, 403);
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        assert.equal(errorMessage(error).length < 500, true);
        return true;
      },
    );
  }, async (url) => url.pathname.endsWith("/_apis/pipelines")
    ? response(403, { message: `Authorization: Bearer ${PAT}; token=${EXTENSION_SECRET}` })
    : projectResponse(url));

  await withPipelineBackend(async ({ call }) => {
    await assert.rejects(
      () => call("list-pipelines", "azure_devops_list_pipelines", {}),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_CONTINUATION_INVALID"
        && !errorMessage(error).includes(PAT),
    );
  }, async (url) => url.pathname.endsWith("/_apis/pipelines")
    ? response(200, { count: 0, value: [] }, { "x-ms-continuationtoken": PAT })
    : projectResponse(url));
});

test("creates a YAML Pipeline only after validating repository project, default branch, and file existence", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    const agentInput = {
      repositoryReference: `azure-devops://${ORGANIZATION}/${PROJECT}/${REPOSITORY_ID}`,
      name: "CI",
      yamlPath: "pipelines/ci.yml",
      folder: "\\Build",
    };
    const result = await call("create-pipeline", "azure_devops_create_pipeline", agentInput);

    assert.deepEqual(requests.map(({ method, url }) => ({ method, url: url.toString() })), [
      { method: "GET", url: `https://dev.azure.com/${ORGANIZATION}/_apis/projects/${PROJECT}?api-version=7.1` },
      { method: "GET", url: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}?api-version=7.1` },
      {
        method: "GET",
        url: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/items?api-version=7.1&includeContent=false&path=%2Fpipelines%2Fci.yml&versionDescriptor.version=main&versionDescriptor.versionType=branch`,
      },
      { method: "GET", url: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/pipelines?%24top=100&api-version=7.1` },
      { method: "POST", url: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_apis/pipelines?api-version=7.1` },
    ]);
    assert.equal(requests[1]?.url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`), true);
    assert.deepEqual(requests[4]?.body, {
      name: "CI",
      folder: "\\Build",
      configuration: {
        type: "yaml",
        path: YAML_PATH,
        repository: { id: REPOSITORY_ID, name: "sample-repository", type: "azureReposGit" },
      },
    });
    assert.deepEqual(result.body, {
      alreadyExists: false,
      created: true,
      pipeline: {
        folder: "\\Build",
        id: 31,
        name: "CI",
        repositoryID: REPOSITORY_ID,
        repositoryName: "sample-repository",
        yamlPath: "pipelines/ci.yml",
      },
    });
    assert.equal(requests[2]?.url.searchParams.get("versionDescriptor.version"), "main");
    assert.equal(requests[2]?.url.searchParams.get("includeContent"), "false");
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) {
      return response(200, { path: YAML_PATH, isFolder: false });
    }
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") return response(200, { count: 0, value: [] });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method === "POST") {
      return response(200, {
        id: 31,
        name: "CI",
        folder: "\\Build",
        configuration: {
          type: "yaml",
          path: YAML_PATH,
          repository: { id: REPOSITORY_ID, name: "sample-repository", type: "azureReposGit" },
        },
      });
    }
    return projectResponse(url);
  });
});

test("accepts an Azure Git YAML blob response without the optional isFolder field", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    const result = await call("create-pipeline", "azure_devops_create_pipeline", {
      repositoryID: REPOSITORY_ID,
      name: "AI_Traning HTML CI",
      yamlPath: "azure-pipelines.yml",
    });

    assert.deepEqual(result.body, {
      alreadyExists: false,
      created: true,
      pipeline: {
        folder: "\\",
        id: 29,
        name: "AI_Traning HTML CI",
        repositoryID: REPOSITORY_ID,
        repositoryName: "sample-repository",
        yamlPath: "azure-pipelines.yml",
      },
    });
    assert.equal(requests.some(({ method }) => method === "POST"), true);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: "/azure-pipelines.yml", gitObjectType: "blob" });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") return response(200, { count: 0, value: [] });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method === "POST") {
      return response(200, {
        id: 29,
        name: "AI_Traning HTML CI",
        folder: "\\",
        configuration: {
          type: "yaml",
          path: "/azure-pipelines.yml",
          repository: { id: REPOSITORY_ID, name: "sample-repository", type: "azureReposGit" },
        },
      });
    }
    return projectResponse(url);
  });
});

test("accepts the documented Pipeline Create response with summary fields and configuration type", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    const result = await call("create-pipeline", "azure_devops_create_pipeline", {
      repositoryID: REPOSITORY_ID,
      name: "AI_Traning HTML CI",
      yamlPath: "azure-pipelines.yml",
    });

    assert.deepEqual(result.body, {
      alreadyExists: false,
      created: true,
      pipeline: {
        folder: "\\",
        id: 29,
        name: "AI_Traning HTML CI",
        repositoryID: REPOSITORY_ID,
        repositoryName: "sample-repository",
        yamlPath: "azure-pipelines.yml",
      },
    });
    assert.equal(requests.some(({ method }) => method === "POST"), true);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: "/azure-pipelines.yml", isFolder: false });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") return response(200, { count: 0, value: [] });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method === "POST") {
      return response(200, {
        id: 29,
        name: "AI_Traning HTML CI",
        folder: "\\",
        revision: 1,
        configuration: { type: "yaml" },
      });
    }
    return projectResponse(url);
  });
});

test("returns the existing identical Pipeline instead of posting a duplicate definition", async () => {
  let createRequests = 0;
  await withPipelineBackend(async ({ call, requests }) => {
    const result = await call("create-pipeline", "azure_devops_create_pipeline", {
      repositoryID: REPOSITORY_ID,
      name: "CI",
      yamlPath: "pipelines/ci.yml",
      folder: "\\Build",
    });

    assert.deepEqual(result.body, {
      alreadyExists: true,
      created: false,
      pipeline: {
        folder: "\\Build",
        id: 31,
        name: "CI",
        repositoryID: REPOSITORY_ID,
        repositoryName: "sample-repository",
        yamlPath: "pipelines/ci.yml",
      },
    });
    assert.equal(createRequests, 0);
    assert.equal(requests.some(({ method }) => method === "POST"), false);
    assert.equal(requests.some(({ url }) => url.pathname.endsWith(`/_apis/git/repositories/${REPOSITORY_ID}`)), true);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: YAML_PATH, isFolder: false });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") {
      return response(200, { count: 1, value: [{ id: 31, name: "CI", folder: "\\Build" }] });
    }
    if (url.pathname.endsWith("/_apis/pipelines/31")) return response(200, pipelineDefinition());
    if (url.pathname.endsWith("/_apis/pipelines") && init.method === "POST") createRequests += 1;
    return projectResponse(url);
  });
});

test("reports same-name Pipeline definitions with different YAML settings as a conflict", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryID: REPOSITORY_ID,
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_NAME_CONFLICT"
        && (error as { statusCode?: number }).statusCode === 409,
    );
    assert.equal(requests.some(({ method }) => method === "POST"), false);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: YAML_PATH, isFolder: false });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") {
      return response(200, { count: 1, value: [{ id: 31, name: "CI", folder: "\\" }] });
    }
    if (url.pathname.endsWith("/_apis/pipelines/31")) {
      return response(200, pipelineDefinition({ configuration: {
        type: "yaml",
        path: "/pipelines/other.yml",
        repository: { id: REPOSITORY_ID, name: "sample-repository", type: "azureReposGit" },
      } }));
    }
    return projectResponse(url);
  });
});

test("reports an unverifiable existing YAML definition when Pipeline details omit repository and path", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryID: REPOSITORY_ID,
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_DEFINITION_UNVERIFIABLE"
        && (error as { statusCode?: number }).statusCode === 409,
    );
    assert.equal(requests.some(({ method, url }) => method === "POST" && url.pathname.endsWith("/_apis/pipelines")), false);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: YAML_PATH, isFolder: false });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method !== "POST") {
      return response(200, { count: 1, value: [{ id: 31, name: "CI", folder: "\\" }] });
    }
    if (url.pathname.endsWith("/_apis/pipelines/31")) {
      return response(200, { id: 31, name: "CI", folder: "\\", revision: 1, configuration: { type: "yaml" } });
    }
    return projectResponse(url);
  });
});

test("rejects a missing default-branch YAML and repository identity mismatches before pipeline creation", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryName: "sample-repository",
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_NOT_FOUND",
    );
    assert.equal(requests.some(({ url }) => url.pathname.endsWith("/_apis/pipelines")), false);
    assert.equal(requests.some(({ url }) => url.pathname.endsWith("/_apis/git/repositories/sample-repository")), true);
  }, async (url) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(404, { message: `Missing ${PAT}` });
    return projectResponse(url);
  });

  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryID: REPOSITORY_ID,
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PROJECT_MISMATCH",
    );
    assert.equal(requests.some(({ url }) => url.pathname.endsWith("/items")), false);
  }, async (url) => url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")
    ? response(200, repositoryMetadata({ project: { id: "33333333-3333-4333-8333-333333333333", name: PROJECT } }))
    : projectResponse(url));
});

test("refuses ambiguous repository selectors and bounds unknown create outcomes", async () => {
  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryID: REPOSITORY_ID,
        repositoryName: "sample-repository",
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_REPOSITORY_IDENTITY_AMBIGUOUS",
    );
    assert.equal(requests.length, 0);
  }, async () => response(500, {}));

  await withPipelineBackend(async ({ call, requests }) => {
    await assert.rejects(
      () => call("create-pipeline", "azure_devops_create_pipeline", {
        repositoryID: REPOSITORY_ID,
        name: "CI",
        yamlPath: "pipelines/ci.yml",
      }),
      (error: unknown) => {
        assert.equal(errorCode(error), "ADO_PIPELINE_CREATE_OUTCOME_UNKNOWN");
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
    assert.equal(requests.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/_apis/pipelines")).length, 1);
  }, async (url, init) => {
    if (url.pathname.includes("/_apis/git/repositories/") && !url.pathname.endsWith("/items")) return repositoryResponse(url);
    if (url.pathname.endsWith("/items")) return response(200, { path: YAML_PATH, isFolder: false });
    if (url.pathname.endsWith("/_apis/pipelines") && init.method === "POST") {
      throw new Error(`transport failed with ${PAT} and ${EXTENSION_SECRET}`);
    }
    if (url.pathname.endsWith("/_apis/pipelines")) return response(200, { count: 0, value: [] });
    return projectResponse(url);
  });
});

test("Pipeline Create repository selector errors preserve operation-specific codes and statuses", async () => {
  const cases = [
    {
      input: {},
      code: "AZURE_DEVOPS_REPOSITORY_REFERENCE_REQUIRED",
      status: 400,
    },
    {
      input: { repositoryID: REPOSITORY_ID, repositoryName: "sample-repository" },
      code: "ADO_PIPELINE_REPOSITORY_IDENTITY_AMBIGUOUS",
      status: 400,
    },
    {
      input: { repositoryReference: "not-a-repository-reference" },
      code: "AZURE_DEVOPS_REPOSITORY_REFERENCE_INVALID",
      status: 400,
    },
    {
      input: { repositoryReference: `azure-devops://other/${PROJECT}/${REPOSITORY_ID}` },
      code: "AZURE_DEVOPS_ORGANIZATION_MISMATCH",
      status: 409,
    },
    {
      input: { repositoryReference: `azure-devops://${ORGANIZATION}/other-project/${REPOSITORY_ID}` },
      code: "AZURE_DEVOPS_PROJECT_MISMATCH",
      status: 409,
    },
  ];

  for (const scenario of cases) {
    await withPipelineBackend(async ({ call, requests }) => {
      await assert.rejects(
        () => call("create-pipeline", "azure_devops_create_pipeline", {
          ...scenario.input,
          name: "CI",
          yamlPath: "pipelines/ci.yml",
        }),
        (error: unknown) => errorCode(error) === scenario.code
          && (error as { statusCode?: number }).statusCode === scenario.status,
      );
      assert.equal(requests.length, 0);
    }, async () => response(500, {}));
  }
});

test("registers Pipeline Plugin tools with bounded schemas and routes only policy-controlled input through the BFF", async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseURL = process.env.AGENT_SYSTEM_BFF_BASE_URL;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-pipeline-bff.test";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      path: url.pathname,
      project: url.searchParams.get("project") ?? undefined,
    });
    const payload = url.pathname.endsWith("/list-pipelines")
      ? { count: 1, pipelines: [{ id: 17, name: "CI", folder: "\\Build" }], continuationToken: "page-2" }
      : {
        alreadyExists: false,
        created: true,
        pipeline: {
          id: 31,
          name: "CI",
          folder: "\\Build",
          repositoryID: REPOSITORY_ID,
          repositoryName: "sample-repository",
          yamlPath: "pipelines/ci.yml",
        },
      };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
    const listTool = runtime.azure_devops_list_pipelines;
    const createTool = runtime.azure_devops_create_pipeline;
    assert.ok(listTool);
    assert.ok(createTool);
    assert.deepEqual(Object.keys(listTool.input.properties), ["project", "continuationToken"]);
    assert.deepEqual(Object.keys(createTool.input.properties), ["project", "repositoryReference", "repositoryID", "repositoryName", "name", "yamlPath", "folder"]);

    const toolContext = { directory: "/projects/managed-project", worktree: "/projects/managed-project" };
    const listResult = await listTool.execute({ continuationToken: "page-2" }, toolContext);
    assert.deepEqual(JSON.parse(listResult.content), {
      count: 1,
      pipelines: [{ id: 17, name: "CI", folder: "\\Build" }],
      continuationToken: "page-2",
    });
    const createResult = await createTool.execute({
      repositoryID: REPOSITORY_ID,
      name: "CI",
      yamlPath: "pipelines/ci.yml",
      folder: "\\Build",
    }, toolContext);
    assert.equal(JSON.parse(createResult.content).created, true);
    assert.deepEqual(requests, [
      {
        body: { tool: "azure_devops_list_pipelines", agentInput: { continuationToken: "page-2" } },
        path: "/bff/extensions/azure-devops-platform/backend/list-pipelines",
        project: "managed-project",
      },
      {
        body: {
          tool: "azure_devops_create_pipeline",
          agentInput: { repositoryID: REPOSITORY_ID, name: "CI", yamlPath: "pipelines/ci.yml", folder: "\\Build" },
        },
        path: "/bff/extensions/azure-devops-platform/backend/create-pipeline",
        project: "managed-project",
      },
    ]);
    assert.equal(JSON.stringify(requests).includes("organization"), false);
    assert.equal(JSON.stringify(requests).includes("credential"), false);
    assert.equal(JSON.stringify(requests).includes("remoteUrl"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseURL);
  }
});

test("validates Pipeline tool response schemas and drops unknown data", () => {
  assert.deepEqual(readAzureDevOpsPipelineListResponse({
    count: 1,
    pipelines: [{ id: 17, name: "CI", folder: "\\Build", authorization: PAT }],
    continuationToken: "next",
    token: PAT,
  }), {
    count: 1,
    pipelines: [{ id: 17, name: "CI", folder: "\\Build" }],
    continuationToken: "next",
  });
  assert.deepEqual(readAzureDevOpsPipelineCreateResponse({
    created: true,
    alreadyExists: false,
    pipeline: {
      id: 31,
      name: "CI",
      folder: "\\Build",
      repositoryID: REPOSITORY_ID,
      repositoryName: "sample-repository",
      yamlPath: "pipelines/ci.yml",
      authorization: PAT,
    },
  }), {
    created: true,
    alreadyExists: false,
    pipeline: {
      id: 31,
      name: "CI",
      folder: "\\Build",
      repositoryID: REPOSITORY_ID,
      repositoryName: "sample-repository",
      yamlPath: "pipelines/ci.yml",
    },
  });
  assert.deepEqual(readAzureDevOpsPipelineListResponse({
    count: 1,
    pipelines: [{ id: 17, name: "CI", folder: "\\" }],
  }), {
    count: 1,
    pipelines: [{ id: 17, name: "CI", folder: "\\" }],
  });
  assert.throws(
    () => readAzureDevOpsPipelineCreateResponse({
      created: true,
      alreadyExists: false,
      pipeline: { id: 31, name: "CI", folder: "\\", repositoryID: REPOSITORY_ID, repositoryName: "repo", yamlPath: "../ci.yml" },
    }),
    (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PIPELINE_RESPONSE_INVALID",
  );
});

type RecordedRequest = { authorization: string | null; body?: Record<string, unknown>; method: string; url: URL };

async function withPipelineBackend(
  run: (fixture: {
    call: (path: string, tool: string, agentInput: Record<string, unknown>) => Promise<any>;
    requests: RecordedRequest[];
  }) => Promise<void>,
  mockResponse: (url: URL, init: RequestInit) => Promise<Response>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "azure-devops-pipeline-backend-"));
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  const secret = randomBytes(32).toString("hex");
  const requests: RecordedRequest[] = [];
  const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
  process.env.EXTENSION_SECRET_KEY = secret;
  process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({
      authorization: new Headers(init.headers).get("Authorization"),
      body,
      method: init.method ?? "GET",
      url,
    });
    return mockResponse(url, init);
  };

  try {
    const runtime = await activate();
    await runtime.handle({ request: {
      body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
      headers: {},
      method: "POST",
      path: "store-credential",
      query: {},
    } });
    const call = async (path: string, tool: string, agentInput: Record<string, unknown>) => {
      const resolvedToolCall = resolveAzureDevOpsToolCall(tool as never, policy, agentInput, {
        organization: ORGANIZATION,
        project: PROJECT,
      });
      requests.length = 0;
      return runtime.handle({ request: {
        body: { tool, agentInput },
        extensionContext: {
          azureDevOps: {
            effectiveContext: {
              adoProject: PROJECT,
              organization: ORGANIZATION,
              parameterPolicy: policy,
            },
            resolvedToolCall,
          },
        },
        headers: { "x-extension-secret-key": secret },
        method: "POST",
        path,
        query: { project: "managed-project", scope: "project" },
      } });
    };
    await run({ call, requests });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
    restoreEnvironment("ADO_CREDENTIAL_STORE_PATH", previousStorePath);
    await rm(root, { force: true, recursive: true });
  }
}

function projectResponse(url: URL): Response {
  if (url.pathname.endsWith(`/_apis/projects/${PROJECT}`)) {
    return response(200, { id: PROJECT_ID, name: PROJECT });
  }
  return response(404, {});
}

function repositoryResponse(url: URL): Response {
  if (url.pathname.endsWith("/items")) return response(200, { path: YAML_PATH, isFolder: false });
  return response(200, repositoryMetadata());
}

function repositoryMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPOSITORY_ID,
    name: "sample-repository",
    project: { id: PROJECT_ID, name: PROJECT },
    defaultBranch: "refs/heads/main",
    ...overrides,
  };
}

function pipelineDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 31,
    name: "CI",
    folder: "\\Build",
    configuration: {
      type: "yaml",
      path: YAML_PATH,
      repository: { id: REPOSITORY_ID, name: "sample-repository", type: "azureReposGit" },
    },
    ...overrides,
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
