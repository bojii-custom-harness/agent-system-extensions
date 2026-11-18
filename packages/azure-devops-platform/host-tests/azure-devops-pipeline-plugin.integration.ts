import assert from "node:assert/strict";
import test from "node:test";
import { createAzureDevOpsToolDefinitions } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import { AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/agent/parameters.ts";
import { jsonSchemaAccepts } from "./helpers/json-schema.ts";

test("registers the three project-scoped Pipeline tools with bounded schemas and policy allowlists", async () => {
  const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
  const preview = runtime.azure_devops_preview_pipeline;
  const run = runtime.azure_devops_run_pipeline;
  const getRun = runtime.azure_devops_get_pipeline_run;
  assert.ok(preview);
  assert.ok(run);
  assert.ok(getRun);
  assert.deepEqual(Object.keys(preview.input.properties), ["project", "pipelineId", "branchRef", "templateParameters"]);
  assert.deepEqual(Object.keys(run.input.properties), ["project", "pipelineId", "branchRef", "templateParameters"]);
  assert.deepEqual(Object.keys(getRun.input.properties), ["project", "pipelineId", "runId"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_preview_pipeline, ["project", "pipelineId", "branchRef", "templateParameters"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_run_pipeline, ["project", "pipelineId", "branchRef", "templateParameters"]);
  assert.deepEqual(AZURE_DEVOPS_PLUGIN_AGENT_PARAMETERS.azure_devops_get_pipeline_run, ["project", "pipelineId", "runId"]);

  const pipelineId = run.input.properties.pipelineId;
  const runId = getRun.input.properties.runId;
  const branchRef = run.input.properties.branchRef;
  const templateParameters = run.input.properties.templateParameters;
  assert.equal(jsonSchemaAccepts(pipelineId, 42), true);
  assert.equal(jsonSchemaAccepts(pipelineId, 0), false);
  assert.equal(jsonSchemaAccepts(pipelineId, 2_147_483_648), false);
  assert.equal(jsonSchemaAccepts(runId, 57), true);
  assert.equal(jsonSchemaAccepts(branchRef, "refs/heads/main"), true);
  assert.equal(jsonSchemaAccepts(branchRef, "main"), false);
  assert.equal(jsonSchemaAccepts(templateParameters, { environment: "staging", enabled: true, replicas: 3 }), true);
  assert.equal(jsonSchemaAccepts(templateParameters, { nested: { key: "value" } }), false);
});

test("routes Pipeline preview, explicit run, and status requests through the existing project BFF", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ body, path: endpoint.pathname, project: endpoint.searchParams.get("project") ?? undefined });
    if (endpoint.pathname.endsWith("/preview-pipeline")) {
      return new Response(JSON.stringify({ pipelineId: 42, previewOnly: true, finalYaml: "steps: []\n", truncated: false }), {
        headers: { "content-type": "application/json" }, status: 200,
      });
    }
    if (endpoint.pathname.endsWith("/run-pipeline")) {
      return new Response(JSON.stringify({
        id: 57,
        pipelineId: 42,
        pipelineName: "Build",
        name: "20261003.1",
        state: "inProgress",
        result: "unknown",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    }
    return new Response(JSON.stringify({
      id: 57,
      pipelineId: 42,
      pipelineName: "Build",
      state: "completed",
      result: "succeeded",
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };

  try {
    const runtime = createAzureDevOpsToolDefinitions({ project: "managed-project" });
    const context = { metadata: async () => undefined };
    const preview = await runtime.azure_devops_preview_pipeline.execute({
      pipelineId: 42,
      branchRef: "refs/heads/main",
    }, context);
    const run = await runtime.azure_devops_run_pipeline.execute({
      pipelineId: 42,
      templateParameters: { environment: "staging" },
    }, context);
    const status = await runtime.azure_devops_get_pipeline_run.execute({ pipelineId: 42, runId: 57 }, context);

    assert.deepEqual(requests, [
      {
        body: { tool: "azure_devops_preview_pipeline", agentInput: { pipelineId: 42, branchRef: "refs/heads/main" } },
        path: "/bff/extensions/azure-devops-platform/backend/preview-pipeline",
        project: "managed-project",
      },
      {
        body: { tool: "azure_devops_run_pipeline", agentInput: { pipelineId: 42, templateParameters: { environment: "staging" } } },
        path: "/bff/extensions/azure-devops-platform/backend/run-pipeline",
        project: "managed-project",
      },
      {
        body: { tool: "azure_devops_get_pipeline_run", agentInput: { pipelineId: 42, runId: 57 } },
        path: "/bff/extensions/azure-devops-platform/backend/get-pipeline-run",
        project: "managed-project",
      },
    ]);
    assert.deepEqual(JSON.parse(preview.content), { pipelineId: 42, previewOnly: true, finalYaml: "steps: []\n", truncated: false });
    assert.deepEqual(JSON.parse(run.content), {
      id: 57, pipelineId: 42, pipelineName: "Build", name: "20261003.1", state: "inProgress", result: "unknown",
    });
    assert.deepEqual(JSON.parse(status.content), {
      id: 57, pipelineId: 42, pipelineName: "Build", state: "completed", result: "succeeded",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
