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
const PAT = "work-item-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
const WORK_ITEM_TOOL = "azure_devops_create_work_item";
const WORK_ITEM_GET_TOOL = "azure_devops_get_work_item";
const WORK_ITEM_REVISIONS_TOOL = "azure_devops_list_work_item_revisions";
const WORK_ITEM_UPDATE_TOOL = "azure_devops_update_work_item";

test("creates a Work Item with the REST 7.1 JSON Patch contract and preserves raw Markdown", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: new URL(String(input)),
      });
      return new Response(JSON.stringify({
        id: 74,
        rev: 1,
        fields: {
          "System.Title": "Create from Markdown",
          "System.WorkItemType": "User Story",
          "System.Description": "unbounded response content must not escape",
        },
        url: "https://untrusted.example/work-item/74",
        relations: [{ rel: "must-not-be-returned" }],
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const markdown = "# Context\n\n- first item\n- second item\n\n```ts\nconst ready = true\n```\n";
      const result = await callTool(runtime, {
        workItemType: "User Story",
        title: "Create from Markdown",
        description: markdown,
        originalEstimate: 1.25,
        remainingWork: 2.5,
        completedWork: 0.75,
        activity: "Development",
        storyPoints: 3.5,
        effort: 5.5,
        size: 8.25,
        businessValue: 100,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "POST");
      assert.equal(calls[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/$User%20Story");
      assert.equal(calls[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(calls[0]?.headers.get("accept"), "application/json");
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.equal(calls[0]?.headers.get("content-type"), "application/json-patch+json");
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Create from Markdown" },
        { op: "add", path: "/fields/System.Description", value: markdown },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate", value: 1.25 },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.RemainingWork", value: 2.5 },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.CompletedWork", value: 0.75 },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Activity", value: "Development" },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: 3.5 },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.Effort", value: 5.5 },
        { op: "add", path: "/fields/Microsoft.VSTS.Scheduling.Size", value: 8.25 },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.BusinessValue", value: 100 },
      ]);
      assert.deepEqual(result, {
        id: 74,
        rev: 1,
        type: "User Story",
        title: "Create from Markdown",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes("unbounded response"), false);
      assert.equal(JSON.stringify(result).includes("untrusted.example"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("partially updates an existing Work Item using the REST 7.1 PATCH contract", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: new URL(String(input)),
      });
      return new Response(JSON.stringify(workItemConfirmation(74, 8, "Task", "Existing title")), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      const description = "## Updated context\n\nPreserve this Markdown.\n";
      const result = await callUpdateTool(runtime, {
        workItemId: 74,
        workItemType: "Task",
        description,
        state: "Active",
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "PATCH");
      assert.equal(calls[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/74");
      assert.equal(calls[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(calls[0]?.headers.get("content-type"), "application/json-patch+json");
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.WorkItemType", value: "Task" },
        { op: "add", path: "/fields/System.Description", value: description },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        { op: "add", path: "/fields/System.State", value: "Active" },
      ]);
      assert.deepEqual(result, {
        id: 74,
        rev: 8,
        type: "Task",
        title: "Existing title",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET_KEY), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("prepends an atomic revision test before the existing Work Item update operations", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; method: string }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
      });
      return new Response(JSON.stringify(workItemConfirmation(74, 9, "Task", "Expected revision update")), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      await callUpdateTool(runtime, { workItemId: 74, expectedRev: 8, title: "Expected revision update" });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "PATCH");
      assert.deepEqual(calls[0]?.body, [
        { op: "test", path: "/rev", value: 8 },
        { op: "add", path: "/fields/System.Title", value: "Expected revision update" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("rejects an invalid Work Item ID or an empty partial update before the REST request", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    try {
      for (const workItemId of [0, -1, 1.5, 2_147_483_648, "74"]) {
        await assert.rejects(
          () => callUpdateTool(runtime, { workItemId, state: "Active" }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_ID_INVALID"),
        );
      }
      await assert.rejects(
        () => callUpdateTool(runtime, { workItemId: 74 }),
        (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_UPDATE_FIELDS_REQUIRED"),
      );
      await assert.rejects(
        () => callUpdateTool(runtime, { workItemId: 74, expectedRev: 7 }),
        (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_UPDATE_FIELDS_REQUIRED"),
      );
      for (const expectedRev of [0, -1, 1.5, 2_147_483_648, "8", Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(
          () => callUpdateTool(runtime, { workItemId: 74, expectedRev, state: "Active" }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_EXPECTED_REV_INVALID"),
        );
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps Work Item update failures to bounded diagnostics without retrying", async () => {
  await withBackend(async (runtime) => {
    const statuses = [
      { status: 404, code: "ADO_WORK_ITEM_UPDATE_FAILED", upstreamType: "WorkItemNotFoundException" },
      { status: 400, code: "ADO_WORK_ITEM_UPDATE_FAILED", upstreamType: "FieldValidationException" },
      { status: 500, code: "ADO_WORK_ITEM_UPDATE_OUTCOME_UNKNOWN", upstreamType: "ServiceUnavailable" },
    ];
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const failure = statuses[calls.length];
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ typeKey: failure?.upstreamType, message: `private error ${PAT}` }), {
        headers: { "content-type": "application/json" },
        status: failure?.status,
      });
    };

    try {
      for (const [index, expected] of statuses.entries()) {
        await assert.rejects(
          () => callUpdateTool(runtime, { workItemId: 74, expectedRev: 7, state: "Active" }),
          (error: unknown) => {
            assert.equal(isCodedError(error, expected.code), true);
            assert.equal((error as { statusCode?: unknown }).statusCode, expected.status);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes("private error"), false);
            return true;
          },
        );
        assert.equal(calls.length, index + 1);
      }
      assert.deepEqual(calls, ["PATCH", "PATCH", "PATCH"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps confirmed stale-revision failures to a bounded conflict without retrying the patch", async () => {
  await withBackend(async (runtime) => {
    const failures = [
      { status: 400, typeKey: "JsonPatchTestOperationFailedException" },
      { status: 409, typeKey: "WorkItemRevisionMismatchException" },
    ];
    const calls: Array<{ body?: unknown; method: string }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
      });
      const failure = failures[calls.length - 1];
      return new Response(JSON.stringify({
        typeKey: failure?.typeKey,
        message: `private revision detail ${PAT} ${EXTENSION_SECRET_KEY}`,
        innerException: { message: `private nested detail ${PAT} ${EXTENSION_SECRET_KEY}` },
      }), { headers: { "content-type": "application/json" }, status: failure?.status });
    };

    try {
      for (const [index, failure] of failures.entries()) {
        await assert.rejects(
          () => callUpdateTool(runtime, { workItemId: 74, expectedRev: 7, state: "Active" }),
          (error: unknown) => {
            assert.equal(isCodedError(error, "ADO_WORK_ITEM_REVISION_CONFLICT"), true);
            assert.equal((error as { statusCode?: unknown }).statusCode, 409);
            assert.match((error as Error).message, /Reread the Work Item and its revision history/);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes(EXTENSION_SECRET_KEY), false);
            assert.equal((error as Error).message.includes("private revision detail"), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(EXTENSION_SECRET_KEY), false);
            assert.ok((error as Error).message.length < 300);
            return true;
          },
        );
        assert.equal(calls.length, index + 1);
        assert.equal(calls[index]?.method, "PATCH");
        assert.deepEqual(calls[index]?.body, [
          { op: "test", path: "/rev", value: 7 },
          { op: "add", path: "/fields/System.State", value: "Active" },
        ]);
      }
      assert.equal(calls.length, failures.length);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("creates a parent-child relation when parentId is supplied and keeps Markdown unchanged", async () => {
  await withBackend(async (runtime) => {
    let body: unknown;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(workItemConfirmation(75, 1, "Task", "Child item")), { status: 200 });
    };

    try {
      const markdown = "## Existing create behavior\n\n- retained as Markdown\n";
      await callTool(runtime, { workItemType: "Task", title: "Child item", description: markdown, parentId: 73 });
      assert.deepEqual(body, [
        { op: "add", path: "/fields/System.Title", value: "Child item" },
        { op: "add", path: "/fields/System.Description", value: markdown },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/contoso/_apis/wit/workItems/73",
          },
        },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps provided classification fields into the same Work Item JSON Patch and omits absent fields", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        url: new URL(String(input)),
      });
      return new Response(JSON.stringify(workItemConfirmation(75, 1, "Task", "Set classification fields")), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callTool(runtime, {
        workItemType: "Task",
        title: "Set classification fields",
        areaPath: "Contoso\\Platform",
        iterationPath: "Contoso\\Sprint 1",
        assignedTo: "developer@example.com",
        priority: 2,
        tags: "agent-system; backend",
        state: "Active",
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url.searchParams.get("bypassRules"), null);
      assert.deepEqual(result, {
        id: 75,
        rev: 1,
        type: "Task",
        title: "Set classification fields",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/75",
      });
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Set classification fields" },
        { op: "add", path: "/fields/System.AreaPath", value: "Contoso\\Platform" },
        { op: "add", path: "/fields/System.IterationPath", value: "Contoso\\Sprint 1" },
        { op: "add", path: "/fields/System.AssignedTo", value: "developer@example.com" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 },
        { op: "add", path: "/fields/System.Tags", value: "agent-system; backend" },
        { op: "add", path: "/fields/System.State", value: "Active" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps Bug and acceptance fields to ADO references and marks only supplied rich text as Markdown", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: new URL(String(input)),
      });
      return new Response(JSON.stringify(workItemConfirmation(75, 1, "Bug", "Preserve type-specific fields")), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      const reproSteps = "## Repro Steps\n\n1. Open the page\n2. Submit the form\n";
      const systemInfo = "- Browser: Chromium\n- Version: 1.2.3\n";
      const acceptanceCriteria = "- [ ] The Markdown stays unchanged\n";
      const result = await callTool(runtime, {
        workItemType: "Bug",
        title: "Preserve type-specific fields",
        description: "# Description\n\nOriginal Markdown behavior.\n",
        reproSteps,
        systemInfo,
        severity: "2 - High",
        acceptanceCriteria,
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "POST");
      assert.equal(calls[0]?.headers.get("content-type"), "application/json-patch+json");
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Preserve type-specific fields" },
        { op: "add", path: "/fields/System.Description", value: "# Description\n\nOriginal Markdown behavior.\n" },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: reproSteps },
        { op: "add", path: "/multilineFieldsFormat/Microsoft.VSTS.TCM.ReproSteps", value: "Markdown" },
        { op: "add", path: "/fields/Microsoft.VSTS.TCM.SystemInfo", value: systemInfo },
        { op: "add", path: "/multilineFieldsFormat/Microsoft.VSTS.TCM.SystemInfo", value: "Markdown" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.Severity", value: "2 - High" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: acceptanceCriteria },
        { op: "add", path: "/multilineFieldsFormat/Microsoft.VSTS.Common.AcceptanceCriteria", value: "Markdown" },
      ]);
      assert.deepEqual(result, {
        id: 75,
        rev: 1,
        type: "Bug",
        title: "Preserve type-specific fields",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/75",
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("uses ADO-confirmed Work Item type and title when the Project process normalizes values", async () => {
  await withBackend(async (runtime) => {
    let body: unknown;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify(workItemConfirmation(81, 3, "User Story", "Normalized by the project process")), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      const result = await callTool(runtime, {
        workItemType: "user story",
        title: "Requested title",
      });

      assert.deepEqual(body, [{ op: "add", path: "/fields/System.Title", value: "Requested title" }]);
      assert.deepEqual(result, {
        id: 81,
        rev: 3,
        type: "User Story",
        title: "Normalized by the project process",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/81",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("treats missing or malformed ADO type/title confirmation as an unknown create outcome", async () => {
  await withBackend(async (runtime) => {
    const responses = [
      { id: 82, rev: 1, fields: { "System.WorkItemType": "Task" } },
      { id: 83, rev: 1, fields: { "System.WorkItemType": 42, "System.Title": "Malformed type" } },
      { id: 84, rev: 1, fields: { "System.WorkItemType": "Task", "System.Title": PAT } },
    ];
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(responses[calls++]), {
      headers: { "content-type": "application/json" },
      status: 200,
    });

    try {
      for (let index = 0; index < responses.length; index += 1) {
        await assert.rejects(
          () => callTool(runtime, { workItemType: "Task", title: `Unknown confirmation ${index}` }),
          (error: unknown) => {
            assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_OUTCOME_UNKNOWN"), true);
            assert.equal((error as { statusCode?: unknown }).statusCode, 502);
            assert.match((error as Error).message, /before retrying/);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
            return true;
          },
        );
      }
      assert.equal(calls, responses.length);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("keeps ADO process rejection for a type-specific field bounded and secret-safe", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    let patch: unknown;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      patch = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return new Response(JSON.stringify({
        typeKey: "FieldRequiresValueException",
        message: `The process rejected System Info: ${PAT}`,
        innerException: { message: `private detail ${PAT}` },
      }), { headers: { "content-type": "application/json" }, status: 400 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, {
          workItemType: "Bug",
          title: "Process-specific rejection",
          systemInfo: "- Platform: Linux\n",
        }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_FAILED"), true);
          assert.match((error as Error).message, /HTTP 400/);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal((error as Error).message.includes("process rejected"), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
          assert.deepEqual((error as { details?: unknown }).details, {
            upstreamStatus: 400,
            upstreamCode: "FieldRequiresValueException",
          });
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.deepEqual(patch, [
        { op: "add", path: "/fields/System.Title", value: "Process-specific rejection" },
        { op: "add", path: "/fields/Microsoft.VSTS.TCM.SystemInfo", value: "- Platform: Linux\n" },
        { op: "add", path: "/multilineFieldsFormat/Microsoft.VSTS.TCM.SystemInfo", value: "Markdown" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("rejects invalid Work Item Priority before the REST request", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, { workItemType: "Task", title: "Invalid priority", priority: 2.5 }),
        (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_PRIORITY_INVALID"),
      );
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("rejects invalid parent IDs before sending the create request", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    try {
      for (const parentId of [0, -1, 1.5, 2_147_483_648, "73"]) {
        await assert.rejects(
          () => callTool(runtime, { workItemType: "Task", title: "Invalid parent", parentId }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_PARENT_ID_INVALID"),
        );
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("reports a bounded secret-safe parent relation rejection without retrying", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({
        typeKey: "WorkItemRelationNotAllowedException",
        message: `parent relation denied ${PAT} ${"x".repeat(5_000)}`,
      }), { status: 400 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, { workItemType: "Task", title: "Denied parent relation", parentId: 73 }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_FAILED"), true);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal((error as Error).message.includes("parent relation denied"), false);
          assert.ok((error as Error).message.length < 300);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          return true;
        },
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Denied parent relation" },
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/contoso/_apis/wit/workItems/73",
          },
        },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("returns bounded, secret-safe Azure DevOps classification validation failures", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        typeKey: "FieldValidationException",
        message: `The requested State is unavailable ${PAT}`,
      }), { headers: { "content-type": "application/json" }, status: 400 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, {
          workItemType: "Task",
          title: "Invalid process state",
          state: "Not a configured state",
        }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_FAILED"), true);
          assert.match((error as Error).message, /HTTP 400/);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          assert.equal(JSON.stringify(error).includes("The requested State is unavailable"), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("omits optional estimate fields and rejects invalid numbers before contacting Azure DevOps", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const bodies: unknown[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(workItemConfirmation(76, 1, "Task", "No estimates yet")), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      await callTool(runtime, { workItemType: "Task", title: "No estimates yet" });
      assert.equal(calls, 1);
      assert.deepEqual(bodies, [[{ op: "add", path: "/fields/System.Title", value: "No estimates yet" }]]);
      for (const invalid of [
        { originalEstimate: -0.25 },
        { originalEstimate: Number.POSITIVE_INFINITY },
        { remainingWork: Infinity },
        { completedWork: Number.NaN },
        { storyPoints: "3.5" },
        { effort: -1 },
        { size: Number.NEGATIVE_INFINITY },
        { businessValue: 1.5 },
        { businessValue: -1 },
        { activity: "  " },
        { activity: "x".repeat(129) },
      ]) {
        await assert.rejects(
          () => callTool(runtime, { workItemType: "Task", title: "Invalid estimate", ...invalid }),
          (error: unknown) => {
            assert.equal(isCodedError(error, "ADO_WORK_ITEM_NUMERIC_FIELD_INVALID") || isCodedError(error, "ADO_WORK_ITEM_ACTIVITY_INVALID"), true);
            assert.equal((error as Error).message.includes(PAT), false);
            return true;
          },
        );
      }
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("omits every absent optional field and does not retry an HTTP failure", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: unknown; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const call = {
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
        url: new URL(String(input)),
      };
      calls.push(call);
      return new Response(JSON.stringify({
        typeKey: "FieldRequiresValueException",
        message: `validation denied ${PAT}`,
      }), { headers: { "content-type": "application/json" }, status: 400 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, { workItemType: "Bug", title: "Missing required project field" }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_FAILED"), true);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          assert.match((error as Error).message, /HTTP 400/);
          return true;
        },
      );

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Missing required project field" },
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("reports an ambiguous network outcome without exposing the PAT or retrying", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error(`request timed out while using ${PAT}`);
    };

    try {
      await assert.rejects(
        () => callTool(runtime, { workItemType: "Task", title: "Check before retry" }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_OUTCOME_UNKNOWN"), true);
          assert.match((error as Error).message, /before retrying/);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("treats an upstream server error as an unconfirmed create outcome", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "ServiceUnavailable", message: `temporary ${PAT}` }), { status: 503 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, { workItemType: "Task", title: "Verify before retry" }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_OUTCOME_UNKNOWN"), true);
          assert.match((error as Error).message, /HTTP 503/);
          assert.match((error as Error).message, /before retrying/);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("returns bounded secret-safe REST failures for HTTP 401, 403, and 404 without retrying", async () => {
  await withBackend(async (runtime) => {
    const failures = [
      { status: 401, code: "Unauthorized" },
      { status: 403, code: "Forbidden" },
      { status: 404, code: "WorkItemTypeNotFound" },
    ];
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const failure = failures[calls++];
      return new Response(JSON.stringify({
        typeKey: failure?.code,
        message: `bounded diagnostic ${PAT}`,
        innerException: { message: `private upstream detail ${PAT}` },
      }), { headers: { "content-type": "application/json" }, status: failure?.status });
    };

    try {
      for (const failure of failures) {
        await assert.rejects(
          () => callTool(runtime, { workItemType: "Task", title: `REST HTTP ${failure.status}` }),
          (error: unknown) => {
            assert.equal(isCodedError(error, "ADO_WORK_ITEM_CREATE_FAILED"), true);
            assert.equal((error as { statusCode?: unknown }).statusCode, failure.status);
            assert.match((error as Error).message, new RegExp(`HTTP ${failure.status}`));
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes("private upstream detail"), false);
            assert.deepEqual((error as { details?: unknown }).details, {
              upstreamStatus: failure.status,
              upstreamCode: failure.code,
            });
            assert.ok((error as Error).message.length < 300);
            return true;
          },
        );
      }
      assert.equal(calls, failures.length);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("routes the Plugin Tool through BFF policy resolution and the real Extension backend to mocked ADO REST", async () => {
  await withBackend(async () => {
    const managedProject = "managed-project";
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    policy.tools[WORK_ITEM_TOOL].fields.assignedTo = {
      mode: "fixed",
      value: "fixed-owner@example.com",
    };
    const adoRequests: Array<{ body: unknown; headers: Headers; url: URL }> = [];
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    let extensionSettingsProjectRead: string | undefined;
    const service = new ExtensionBackendService(
      {
        readBackend: async () => ({
          content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
          effectiveScope: "project",
          extensionId: "azure-devops-platform",
          packageSha256: "d".repeat(64),
          version: "1.6.46",
        }),
        readSettings: async (_extensionId: string, _scope: string, project: string) => {
          extensionSettingsProjectRead = project;
          return { azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy: policy } };
        },
      } as never,
      [],
    );
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-work-item-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bffRequests.push({ body, headers, url });
        const path = url.pathname.split("/backend/")[1] ?? "";
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
          method: init?.method ?? "GET",
          params: { "*": path, extensionId: "azure-devops-platform" },
          query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
        } as never, reply as never);
        return new Response(JSON.stringify(responseBody), {
          headers: { "content-type": "application/json" },
          status,
        });
      }

      adoRequests.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers,
        url,
      });
      return new Response(JSON.stringify({
        id: 918,
        rev: 2,
        fields: {
          "System.WorkItemType": "Task",
          "System.Title": "ADO canonical title",
          "System.Description": `hidden upstream field ${PAT}`,
        },
        url: "https://untrusted.example/workItems/918",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: managedProject } as never) as unknown as Record<string, any>;
      const markdown = "# Through the full seam\n\n- preserved Markdown\n";
      const acceptanceCriteria = "- [ ] Created through resolved policy\n";
      const result = await plugin[WORK_ITEM_TOOL]!.execute({
        workItemType: "User Story",
        title: "Plugin input title",
        description: markdown,
        acceptanceCriteria,
      }, { metadata: async () => undefined });

      assert.equal(extensionSettingsProjectRead, managedProject);
      assert.equal(bffRequests.length, 1);
      assert.equal(bffRequests[0]?.url.pathname, "/bff/extensions/azure-devops-platform/backend/create-work-item");
      assert.equal(bffRequests[0]?.url.searchParams.get("project"), managedProject);
      assert.equal(bffRequests[0]?.url.searchParams.get("scope"), "project");
      assert.equal(bffRequests[0]?.headers.get("x-agent-system-workspace"), managedProject);
      assert.equal(bffRequests[0]?.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      assert.deepEqual(bffRequests[0]?.body, {
        tool: WORK_ITEM_TOOL,
        agentInput: {
          workItemType: "User Story",
          title: "Plugin input title",
          description: markdown,
          acceptanceCriteria,
        },
      });
      assert.equal(adoRequests.length, 1);
      assert.equal(adoRequests[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/$User%20Story");
      assert.equal(adoRequests[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(adoRequests[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.equal(adoRequests[0]?.headers.get("content-type"), "application/json-patch+json");
      assert.deepEqual(adoRequests[0]?.body, [
        { op: "add", path: "/fields/System.Title", value: "Plugin input title" },
        { op: "add", path: "/fields/System.Description", value: markdown },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
        { op: "add", path: "/fields/System.AssignedTo", value: "fixed-owner@example.com" },
        { op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: acceptanceCriteria },
        { op: "add", path: "/multilineFieldsFormat/Microsoft.VSTS.Common.AcceptanceCriteria", value: "Markdown" },
      ]);
      assert.deepEqual(JSON.parse(result.content), {
        id: 918,
        rev: 2,
        type: "Task",
        title: "ADO canonical title",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/918",
      });
      assert.equal(result.content.includes(PAT), false);
      assert.equal(result.content.includes(EXTENSION_SECRET_KEY), false);
      assert.equal(result.content.includes("hidden upstream field"), false);
      assert.equal(result.content.includes("untrusted.example"), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await service.close();
    }
  });
});

async function withBackend(run: (runtime: { handle: (input: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-work-item-backend-"));
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
  parameters: Record<string, unknown>,
  tool = WORK_ITEM_TOOL,
  path = "create-work-item",
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
          parameterPolicy: {
            tools: {
              [tool]: { fields: { project: { mode: "fixed", value: PROJECT } } },
            },
          },
        },
        resolvedToolCall: { tool, parameters: { organization: ORGANIZATION, project: PROJECT, ...parameters } },
      },
    },
  } });
  return (response as { body: unknown }).body;
}

function callUpdateTool(runtime: { handle: (input: unknown) => Promise<unknown> }, parameters: Record<string, unknown>): Promise<unknown> {
  return callTool(runtime, parameters, WORK_ITEM_UPDATE_TOOL, "update-work-item");
}

function isCodedError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function workItemConfirmation(id: number, rev: number, type: string, title: string): Record<string, unknown> {
  return {
    id,
    rev,
    fields: {
      "System.WorkItemType": type,
      "System.Title": title,
    },
  };
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

test("resolves update Work Item Tool context through BFF before dispatching the Extension backend", async () => {
  await withBackend(async () => {
    const managedProject = "managed-project";
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    policy.tools[WORK_ITEM_UPDATE_TOOL].fields.state = { mode: "fixed", value: "Active" };
    const bffRequests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
    const adoRequests: Array<{ body?: unknown; method: string; url: URL }> = [];
    const service = new ExtensionBackendService(
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
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-work-item-update-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const path = url.pathname.split("/backend/")[1] ?? "";
        bffRequests.push({ body, path, project: url.searchParams.get("project") ?? undefined });
        let status = 200;
        const reply = {
          raw: { headersSent: false, writableEnded: false },
          sent: false,
          code(nextStatus: number) { status = nextStatus; return this; },
          header() { return this; },
          send(responseBody: unknown) { return responseBody; },
        };
        const bodyResult = await service.handle({
          body,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          method: init?.method ?? "GET",
          params: { "*": path, extensionId: "azure-devops-platform" },
          query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
        } as never, reply as never);
        return new Response(JSON.stringify(bodyResult), { headers: { "content-type": "application/json" }, status });
      }

      adoRequests.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
        url,
      });
      return new Response(JSON.stringify(workItemConfirmation(74, 9, "Task", "Updated through BFF")), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: managedProject } as never) as unknown as Record<string, any>;
      const result = await plugin[WORK_ITEM_UPDATE_TOOL]!.execute({ workItemId: 74, expectedRev: 8, title: "Updated through BFF" }, { metadata: async () => undefined });

      assert.equal(bffRequests.length, 1);
      assert.deepEqual(bffRequests[0], {
        body: { tool: WORK_ITEM_UPDATE_TOOL, agentInput: { workItemId: 74, expectedRev: 8, title: "Updated through BFF" } },
        path: "update-work-item",
        project: managedProject,
      });
      assert.equal(adoRequests.length, 1);
      assert.equal(adoRequests[0]?.method, "PATCH");
      assert.equal(adoRequests[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/74");
      assert.deepEqual(adoRequests[0]?.body, [
        { op: "test", path: "/rev", value: 8 },
        { op: "add", path: "/fields/System.Title", value: "Updated through BFF" },
        { op: "add", path: "/fields/System.State", value: "Active" },
      ]);
      assert.deepEqual(JSON.parse(result.content), {
        id: 74,
        rev: 9,
        type: "Task",
        title: "Updated through BFF",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
      });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await service.close();
    }
  });
});

test("reads the current Work Item revision and allowlisted fields through Azure DevOps REST 7.1", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ headers: new Headers(init?.headers), method: init?.method ?? "GET", url: new URL(String(input)) });
      return new Response(JSON.stringify({
        id: 74,
        rev: 12,
        url: "https://untrusted.example/workItems/74",
        fields: {
          "System.WorkItemType": "Bug",
          "System.Title": "Cannot sign in",
          "System.State": "Committed",
          "System.Description": "# Repro\n\n- Preserve this Markdown.\n",
          "System.AreaPath": "Contoso\\Platform",
          "System.IterationPath": "Contoso\\Sprint 4",
          "System.AssignedTo": { displayName: "Ada Lovelace", uniqueName: "ada@example.com", id: PAT, _links: { avatar: "private" } },
          "Microsoft.VSTS.Common.Priority": 2,
          "System.Tags": "login; urgent",
          "Microsoft.VSTS.TCM.ReproSteps": "1. Open the app\n2. Sign in\n",
          "Microsoft.VSTS.TCM.SystemInfo": "Browser: Chromium\n",
          "Microsoft.VSTS.Common.Severity": "2 - High",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "- [ ] User can sign in\n",
          "Microsoft.VSTS.Scheduling.OriginalEstimate": 3.5,
          "Microsoft.VSTS.Scheduling.RemainingWork": 2.25,
          "Microsoft.VSTS.Scheduling.CompletedWork": 1.25,
          "Microsoft.VSTS.Common.Activity": "Development",
          "Microsoft.VSTS.Scheduling.StoryPoints": 5,
          "Microsoft.VSTS.Scheduling.Effort": 8,
          "Microsoft.VSTS.Scheduling.Size": 13,
          "Microsoft.VSTS.Common.BusinessValue": 100,
          "System.ChangedDate": "2026-10-05T12:34:56Z",
          "System.ChangedBy": { displayName: "Grace Hopper", uniqueName: "grace@example.com", id: "private-id", descriptor: "private" },
          "Custom.PrivateField": "must-not-escape",
        },
        relations: [{ url: "https://private.example/relation" }],
        _links: { self: { href: "https://private.example/work-item" } },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callGetWorkItem(runtime, { workItemId: 74 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "GET");
      assert.equal(calls[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/74");
      assert.equal(calls[0]?.url.searchParams.get("api-version"), "7.1");
      assert.deepEqual(calls[0]?.url.searchParams.get("fields")?.split(","), [
        "System.Id",
        "System.Rev",
        "System.WorkItemType",
        "System.Title",
        "System.Description",
        "System.AreaPath",
        "System.IterationPath",
        "System.AssignedTo",
        "Microsoft.VSTS.Common.Priority",
        "System.Tags",
        "System.State",
        "Microsoft.VSTS.TCM.ReproSteps",
        "Microsoft.VSTS.TCM.SystemInfo",
        "Microsoft.VSTS.Common.Severity",
        "Microsoft.VSTS.Common.AcceptanceCriteria",
        "Microsoft.VSTS.Scheduling.OriginalEstimate",
        "Microsoft.VSTS.Scheduling.RemainingWork",
        "Microsoft.VSTS.Scheduling.CompletedWork",
        "Microsoft.VSTS.Common.Activity",
        "Microsoft.VSTS.Scheduling.StoryPoints",
        "Microsoft.VSTS.Scheduling.Effort",
        "Microsoft.VSTS.Scheduling.Size",
        "Microsoft.VSTS.Common.BusinessValue",
      ]);
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(result, {
        id: 74,
        rev: 12,
        type: "Bug",
        title: "Cannot sign in",
        state: "Committed",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
        description: "# Repro\n\n- Preserve this Markdown.\n",
        areaPath: "Contoso\\Platform",
        iterationPath: "Contoso\\Sprint 4",
        assignedTo: { displayName: "Ada Lovelace", uniqueName: "ada@example.com" },
        priority: 2,
        tags: "login; urgent",
        reproSteps: "1. Open the app\n2. Sign in\n",
        systemInfo: "Browser: Chromium\n",
        severity: "2 - High",
        acceptanceCriteria: "- [ ] User can sign in\n",
        originalEstimate: 3.5,
        remainingWork: 2.25,
        completedWork: 1.25,
        activity: "Development",
        storyPoints: 5,
        effort: 8,
        size: 13,
        businessValue: 100,
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET_KEY), false);
      assert.equal(JSON.stringify(result).includes("private.example"), false);
      assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
      assert.equal(JSON.stringify(result).includes("untrusted.example"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("omits unsupported Work Item fields, uses the returned State, and marks truncated text", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: 74,
      rev: 2,
      fields: {
        "System.WorkItemType": "Task",
        "System.Title": "Large description",
        "System.State": "Resolved",
        "System.Description": "x".repeat(100_001),
        "System.Tags": EXTENSION_SECRET_KEY,
        "System.AreaPath": null,
        "System.AssignedTo": null,
        "System.ChangedDate": null,
        "System.ChangedBy": null,
        "Custom.Secret": "not allowlisted",
      },
      relations: [{ rel: "private" }],
    }), { headers: { "content-type": "application/json" }, status: 200 });

    try {
      const result = await callGetWorkItem(runtime, { workItemId: 74 }) as Record<string, unknown>;
      assert.equal(result.state, "Resolved");
      assert.equal(typeof result.description, "string");
      assert.equal((result.description as string).length, 100_000);
      assert.equal((result.description as string).endsWith("… [truncated]"), true);
      assert.equal(Object.hasOwn(result, "areaPath"), false);
      assert.equal(Object.hasOwn(result, "tags"), false);
      assert.equal(Object.hasOwn(result, "assignedTo"), false);
      assert.equal(Object.hasOwn(result, "changedDate"), false);
      assert.equal(Object.hasOwn(result, "changedBy"), false);
      assert.equal(Object.hasOwn(result, "Custom.Secret"), false);
      assert.equal(Object.hasOwn(result, "relations"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("omits PAT and Extension secret encodings from Work Item detail and revision query projections", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    let currentUnsafeCredential = "";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const fields = {
        "System.WorkItemType": "Task",
        "System.Title": "Secret-safe query projection",
        "System.State": "Active",
        "System.Description": `private field ${currentUnsafeCredential}`,
      };
      if (url.pathname.endsWith("/revisions")) {
        return new Response(JSON.stringify({ count: 1, value: [{ id: 74, rev: 1, fields }] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: 74, rev: 1, fields }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      for (const unsafeValue of credentialVariants(PAT, EXTENSION_SECRET_KEY)) {
        currentUnsafeCredential = unsafeValue;
        const details = await callGetWorkItem(runtime, { workItemId: 74 }) as Record<string, unknown>;
        const revisionPage = await callListWorkItemRevisions(runtime, { workItemId: 74, top: 1 }) as {
          revisions: Array<Record<string, unknown>>;
        };

        assert.equal(Object.hasOwn(details, "description"), false);
        assert.equal(Object.hasOwn(revisionPage.revisions[0] ?? {}, "description"), false);
        const output = JSON.stringify({ details, revisionPage });
        assert.equal(output.includes(unsafeValue), false);
        assert.equal(output.includes(PAT), false);
        assert.equal(output.includes(EXTENSION_SECRET_KEY), false);
      }
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("rejects invalid Work Item read IDs before the Azure DevOps request", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    try {
      for (const workItemId of [0, -1, 1.5, 2_147_483_648, "74"]) {
        await assert.rejects(
          () => callGetWorkItem(runtime, { workItemId }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_ID_INVALID"),
        );
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps missing Work Item fields and Azure DevOps read failures to bounded secret-safe errors", async () => {
  await withBackend(async (runtime) => {
    const invalidResponses: Array<Record<string, unknown>> = [
      { id: 74, rev: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Missing State" } },
      { id: 75, rev: 1, fields: { "System.WorkItemType": "Task", "System.Title": "Mismatched ID", "System.State": "Active" } },
      { id: 74, rev: 0, fields: { "System.WorkItemType": "Task", "System.Title": "Invalid revision", "System.State": "Active" } },
    ];
    const failures = [
      { status: 401, code: "ADO_WORK_ITEM_PERMISSION_DENIED", message: "Azure DevOps denied Work Item read access (HTTP 401)." },
      { status: 403, code: "ADO_WORK_ITEM_PERMISSION_DENIED", message: "Azure DevOps denied Work Item read access (HTTP 403)." },
      { status: 404, code: "ADO_WORK_ITEM_NOT_FOUND_OR_UNAVAILABLE", message: "The Azure DevOps Work Item was not found or is not accessible (HTTP 404)." },
      { status: 503, code: "ADO_WORK_ITEM_GET_FAILED", message: "The Azure DevOps Work Item could not be read (HTTP 503)." },
    ];
    const previousFetch = globalThis.fetch;
    let responseIndex = 0;
    globalThis.fetch = async () => {
      const index = responseIndex++;
      if (index < invalidResponses.length) {
        return new Response(JSON.stringify(invalidResponses[index]), { headers: { "content-type": "application/json" }, status: 200 });
      }
      if (index === invalidResponses.length) return new Response("not-json", { status: 200 });
      const failure = failures[index - invalidResponses.length - 1];
      return new Response(JSON.stringify({ typeKey: "PrivateError", message: `private diagnostic ${PAT}` }), {
        headers: { "content-type": "application/json" },
        status: failure?.status,
      });
    };

    try {
      for (const _invalid of [...invalidResponses, undefined]) {
        await assert.rejects(
          () => callGetWorkItem(runtime, { workItemId: 74 }),
          (error: unknown) => {
            assert.equal(isCodedError(error, "AZURE_DEVOPS_WORK_ITEM_RESPONSE_INVALID"), true);
            assert.equal((error as Error).message.includes(PAT), false);
            return true;
          },
        );
      }
      for (const failure of failures) {
        await assert.rejects(
          () => callGetWorkItem(runtime, { workItemId: 74 }),
          (error: unknown) => {
            assert.equal(isCodedError(error, failure.code), true);
            assert.equal((error as { statusCode?: unknown }).statusCode, failure.status);
            assert.equal((error as Error).message, failure.message);
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes("private diagnostic"), false);
            assert.deepEqual((error as { details?: unknown }).details, { upstreamStatus: failure.status });
            assert.ok((error as Error).message.length < 300);
            return true;
          },
        );
      }
      globalThis.fetch = async () => { throw new Error(`network failure ${PAT}`); };
      await assert.rejects(
        () => callGetWorkItem(runtime, { workItemId: 74 }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_GET_FAILED"), true);
          assert.equal((error as { statusCode?: unknown }).statusCode, 502);
          assert.equal((error as Error).message, "The Azure DevOps Work Item could not be read (HTTP 502).");
          assert.deepEqual((error as { details?: unknown }).details, { upstreamStatus: 502 });
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("routes Work Item reads through Plugin, BFF policy resolution, and the project-scoped Extension backend", async () => {
  await withBackend(async () => {
    const managedProject = "managed-project";
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    policy.tools[WORK_ITEM_GET_TOOL].fields.workItemId = { mode: "fixed", required: true, value: 918 };
    const bffRequests: Array<{ body: Record<string, unknown>; path: string; project?: string }> = [];
    const adoRequests: Array<{ headers: Headers; method: string; url: URL }> = [];
    const service = new ExtensionBackendService(
      {
        readBackend: async () => ({
          content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
          effectiveScope: "project",
          extensionId: "azure-devops-platform",
          packageSha256: "f".repeat(64),
          version: "1.6.46",
        }),
        readSettings: async () => ({
          azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy: policy },
        }),
      } as never,
      [],
    );
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-work-item-get-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const path = url.pathname.split("/backend/")[1] ?? "";
        bffRequests.push({ body, path, project: url.searchParams.get("project") ?? undefined });
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
          method: init?.method ?? "GET",
          params: { "*": path, extensionId: "azure-devops-platform" },
          query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
        } as never, reply as never);
        return new Response(JSON.stringify(responseBody), { headers: { "content-type": "application/json" }, status });
      }

      adoRequests.push({ headers, method: init?.method ?? "GET", url });
      return new Response(JSON.stringify({
        id: 918,
        rev: 6,
        fields: {
          "System.WorkItemType": "Task",
          "System.Title": "Resolved through BFF",
          "System.State": "Active",
          "System.Description": "# Read-only result\n",
          "System.AssignedTo": { displayName: "Project owner", uniqueName: "owner@example.com", id: "private" },
          "System.ChangedDate": "2026-10-05T12:34:56Z",
          "System.ChangedBy": { displayName: "Reviewer", uniqueName: "reviewer@example.com" },
        },
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: managedProject } as never) as unknown as Record<string, any>;
      const getWorkItem = plugin[WORK_ITEM_GET_TOOL]!;
      const result = await getWorkItem.execute({}, { metadata: async () => undefined });

      assert.equal(bffRequests.length, 1);
      assert.deepEqual(bffRequests[0], {
        body: { tool: WORK_ITEM_GET_TOOL, agentInput: {} },
        path: "get-work-item",
        project: managedProject,
      });
      assert.equal(adoRequests.length, 1);
      assert.equal(adoRequests[0]?.method, "GET");
      assert.equal(adoRequests[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workitems/918");
      assert.equal(adoRequests[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(adoRequests[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(JSON.parse(result.content), {
        id: 918,
        rev: 6,
        type: "Task",
        title: "Resolved through BFF",
        state: "Active",
        url: "https://dev.azure.com/contoso/_apis/wit/workItems/918",
        description: "# Read-only result\n",
        assignedTo: { displayName: "Project owner", uniqueName: "owner@example.com" },
      });

      await assert.rejects(
        () => getWorkItem.execute({ workItemId: 919 }, { metadata: async () => undefined }),
        (error: unknown) => isCodedError(error, "AZURE_DEVOPS_FIXED_VALUE_OVERRIDE"),
      );
      assert.equal(bffRequests.length, 2);
      assert.equal(adoRequests.length, 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await service.close();
    }
  });
});

function callGetWorkItem(runtime: { handle: (input: unknown) => Promise<unknown> }, parameters: Record<string, unknown>): Promise<unknown> {
  return callTool(runtime, parameters, WORK_ITEM_GET_TOOL, "get-work-item");
}

function callListWorkItemRevisions(runtime: { handle: (input: unknown) => Promise<unknown> }, parameters: Record<string, unknown>): Promise<unknown> {
  return callTool(runtime, parameters, WORK_ITEM_REVISIONS_TOOL, "list-work-item-revisions");
}

test("lists bounded Work Item revision snapshots using REST 7.1 and the shared public projection", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ headers: new Headers(init?.headers), method: init?.method ?? "GET", url: new URL(String(input)) });
      return new Response(JSON.stringify({
        count: 2,
        value: [
          {
            id: 74,
            rev: 3,
            fields: {
              "System.WorkItemType": "Bug",
              "System.Title": "Latest revision",
              "System.State": "Resolved",
              "System.Description": "x".repeat(100_001),
              "System.AssignedTo": { displayName: "Ada Lovelace", uniqueName: "ada@example.com", id: PAT },
              "System.ChangedDate": "2026-10-05T12:34:56Z",
              "System.ChangedBy": { displayName: "Grace Hopper", uniqueName: "grace@example.com", descriptor: PAT },
              "Custom.PrivateField": `must-not-escape ${PAT}`,
            },
            relations: [{ url: "https://private.example/relation" }],
            _links: { self: { href: "https://private.example/work-item" } },
          },
          {
            id: 74,
            rev: 2,
            fields: {
              "System.WorkItemType": "Bug",
              "System.Title": "Earlier revision",
              "System.State": "Active",
              "System.Description": "# Preserve Markdown\n\n- original content\n",
              "System.ChangedDate": "2026-10-04T10:00:00Z",
              "System.ChangedBy": { displayName: "Alan Turing", uniqueName: "alan@example.com" },
            },
          },
        ],
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callListWorkItemRevisions(runtime, { workItemId: 74, top: 2, skip: 4 }) as Record<string, any>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "GET");
      assert.equal(calls[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workItems/74/revisions");
      assert.equal(calls[0]?.url.searchParams.get("$top"), "2");
      assert.equal(calls[0]?.url.searchParams.get("$skip"), "4");
      assert.equal(calls[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(result, {
        workItemId: 74,
        top: 2,
        skip: 4,
        count: 2,
        hasMore: true,
        nextSkip: 6,
        revisions: [
          {
            id: 74,
            rev: 2,
            type: "Bug",
            title: "Earlier revision",
            state: "Active",
            url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
            description: "# Preserve Markdown\n\n- original content\n",
            changedDate: "2026-10-04T10:00:00Z",
            changedBy: { displayName: "Alan Turing", uniqueName: "alan@example.com" },
            truncatedFields: [],
          },
          {
            id: 74,
            rev: 3,
            type: "Bug",
            title: "Latest revision",
            state: "Resolved",
            url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
            description: `${"x".repeat(100_000 - "… [truncated]".length)}… [truncated]`,
            assignedTo: { displayName: "Ada Lovelace", uniqueName: "ada@example.com" },
            changedDate: "2026-10-05T12:34:56Z",
            changedBy: { displayName: "Grace Hopper", uniqueName: "grace@example.com" },
            truncatedFields: ["description"],
          },
        ],
      });
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET_KEY), false);
      assert.equal(JSON.stringify(result).includes("private.example"), false);
      assert.equal(JSON.stringify(result).includes("Custom.PrivateField"), false);
      assert.equal(JSON.stringify(result).includes("descriptor"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("defaults revision paging and rejects invalid IDs, top, or skip before REST", async () => {
  await withBackend(async (runtime) => {
    const calls: URL[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify([{
        id: 74,
        rev: 1,
        fields: { "System.WorkItemType": "Task", "System.Title": "Initial", "System.State": "New" },
      }]), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callListWorkItemRevisions(runtime, { workItemId: 74 }) as Record<string, unknown>;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.searchParams.get("$top"), "10");
      assert.equal(calls[0]?.searchParams.get("$skip"), "0");
      assert.equal(result.hasMore, false);
      assert.equal(result.nextSkip, undefined);

      for (const workItemId of [0, -1, 1.5, 2_147_483_648, "74"]) {
        await assert.rejects(
          () => callListWorkItemRevisions(runtime, { workItemId }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_ID_INVALID"),
        );
      }
      for (const top of [0, -1, 1.5, 21, "10"]) {
        await assert.rejects(
          () => callListWorkItemRevisions(runtime, { workItemId: 74, top }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_REVISION_TOP_INVALID"),
        );
      }
      for (const skip of [-1, 1.5, 2_147_483_648, "0"]) {
        await assert.rejects(
          () => callListWorkItemRevisions(runtime, { workItemId: 74, skip }),
          (error: unknown) => isCodedError(error, "ADO_WORK_ITEM_REVISION_SKIP_INVALID"),
        );
      }
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("maps revision REST failures and malformed pages to bounded secret-safe errors", async () => {
  await withBackend(async (runtime) => {
    const responses = [
      { status: 401, code: "ADO_WORK_ITEM_PERMISSION_DENIED", message: "Azure DevOps denied Work Item revision read access (HTTP 401)." },
      { status: 403, code: "ADO_WORK_ITEM_PERMISSION_DENIED", message: "Azure DevOps denied Work Item revision read access (HTTP 403)." },
      { status: 404, code: "ADO_WORK_ITEM_NOT_FOUND_OR_UNAVAILABLE", message: "The Azure DevOps Work Item was not found or is not accessible (HTTP 404)." },
      { status: 503, code: "ADO_WORK_ITEM_REVISIONS_LIST_FAILED", message: "Azure DevOps Work Item revisions could not be read (HTTP 503)." },
      { status: 200, code: "AZURE_DEVOPS_WORK_ITEM_REVISIONS_RESPONSE_INVALID", message: undefined },
    ];
    let index = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const current = responses[index++];
      if (current?.status === 200) return new Response("not-json", { status: 200 });
      return new Response(JSON.stringify({ typeKey: "PrivateError", message: `private upstream message ${PAT}` }), {
        headers: { "content-type": "application/json" },
        status: current?.status,
      });
    };

    try {
      for (const expected of responses) {
        await assert.rejects(
          () => callListWorkItemRevisions(runtime, { workItemId: 74 }),
          (error: unknown) => {
            assert.equal(isCodedError(error, expected.code), true);
            if (expected.status !== 200) {
              assert.equal((error as { statusCode?: unknown }).statusCode, expected.status);
              assert.equal((error as Error).message, expected.message);
              assert.deepEqual((error as { details?: unknown }).details, { upstreamStatus: expected.status });
            } else {
              assert.equal((error as { statusCode?: unknown }).statusCode, 502);
            }
            assert.equal((error as Error).message.includes(PAT), false);
            assert.equal((error as Error).message.includes("private upstream message"), false);
            assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
            assert.ok((error as Error).message.length < 300);
            return true;
          },
        );
      }
      globalThis.fetch = async () => { throw new Error(`network failure ${PAT}`); };
      await assert.rejects(
        () => callListWorkItemRevisions(runtime, { workItemId: 74 }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WORK_ITEM_REVISIONS_LIST_FAILED"), true);
          assert.equal((error as { statusCode?: unknown }).statusCode, 502);
          assert.equal((error as Error).message, "Azure DevOps Work Item revisions could not be read (HTTP 502).");
          assert.deepEqual((error as { details?: unknown }).details, { upstreamStatus: 502 });
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details ?? {}).includes(PAT), false);
          return true;
        },
      );
      assert.equal(index, responses.length);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("routes revision history through Plugin, BFF policy, project context, and mocked Azure DevOps REST", async () => {
  await withBackend(async () => {
    const managedProject = "managed-project";
    const policy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    policy.tools[WORK_ITEM_REVISIONS_TOOL].fields.top = { mode: "fixed", value: 2 };
    policy.tools[WORK_ITEM_REVISIONS_TOOL].fields.skip = { mode: "fixed", value: 1 };
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    const adoRequests: Array<{ headers: Headers; method: string; url: URL }> = [];
    const service = new ExtensionBackendService(
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
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://azure-devops-work-item-revisions-bff.test";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bffRequests.push({ body, headers, url });
        const path = url.pathname.split("/backend/")[1] ?? "";
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
          method: init?.method ?? "GET",
          params: { "*": path, extensionId: "azure-devops-platform" },
          query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
        } as never, reply as never);
        return new Response(JSON.stringify(responseBody), { headers: { "content-type": "application/json" }, status });
      }

      adoRequests.push({ headers, method: init?.method ?? "GET", url });
      return new Response(JSON.stringify({
        count: 1,
        value: [{
          id: 74,
          rev: 5,
          fields: {
            "System.WorkItemType": "Task",
            "System.Title": "Revision through BFF",
            "System.State": "Active",
            "System.Description": "# History through full context\n",
            "System.ChangedDate": "2026-10-05T12:34:56Z",
            "System.ChangedBy": { displayName: "Project owner", uniqueName: "owner@example.com", id: PAT },
            "Custom.Hidden": PAT,
          },
        }],
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: managedProject } as never) as unknown as Record<string, any>;
      const tool = plugin[WORK_ITEM_REVISIONS_TOOL]!;
      assert.deepEqual(Object.keys(tool.input.properties), ["project", "workItemId", "top", "skip"]);
      const topSchema = tool.input.properties.top;
      const skipSchema = tool.input.properties.skip;
      assert.equal(jsonSchemaAccepts(topSchema, 1), true);
      assert.equal(jsonSchemaAccepts(topSchema, 20), true);
      assert.equal(jsonSchemaAccepts(topSchema, 21), false);
      assert.equal(jsonSchemaAccepts(skipSchema, 0), true);
      assert.equal(jsonSchemaAccepts(skipSchema, 2_147_483_647), true);
      assert.equal(jsonSchemaAccepts(skipSchema, 2_147_483_648), false);

      const result = await tool.execute({ workItemId: 74 }, { metadata: async () => undefined });
      assert.equal(bffRequests.length, 1);
      assert.equal(bffRequests[0]?.url.pathname, "/bff/extensions/azure-devops-platform/backend/list-work-item-revisions");
      assert.equal(bffRequests[0]?.url.searchParams.get("project"), managedProject);
      assert.equal(bffRequests[0]?.headers.get("x-agent-system-workspace"), managedProject);
      assert.equal(bffRequests[0]?.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      assert.deepEqual(bffRequests[0]?.body, {
        tool: WORK_ITEM_REVISIONS_TOOL,
        agentInput: { workItemId: 74 },
      });
      assert.equal(adoRequests.length, 1);
      assert.equal(adoRequests[0]?.method, "GET");
      assert.equal(adoRequests[0]?.url.pathname, "/contoso/ado-project/_apis/wit/workItems/74/revisions");
      assert.equal(adoRequests[0]?.url.searchParams.get("$top"), "2");
      assert.equal(adoRequests[0]?.url.searchParams.get("$skip"), "1");
      assert.equal(adoRequests[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(adoRequests[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(JSON.parse(result.content), {
        workItemId: 74,
        top: 2,
        skip: 1,
        count: 1,
        hasMore: false,
        revisions: [{
          id: 74,
          rev: 5,
          type: "Task",
          title: "Revision through BFF",
          state: "Active",
          url: "https://dev.azure.com/contoso/_apis/wit/workItems/74",
          description: "# History through full context\n",
          changedDate: "2026-10-05T12:34:56Z",
          changedBy: { displayName: "Project owner", uniqueName: "owner@example.com" },
          truncatedFields: [],
        }],
      });
      assert.equal(result.content.includes(PAT), false);
      assert.equal(result.content.includes(EXTENSION_SECRET_KEY), false);
      assert.equal(result.content.includes("Custom.Hidden"), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBaseUrl === undefined) delete process.env.AGENT_SYSTEM_BFF_BASE_URL;
      else process.env.AGENT_SYSTEM_BFF_BASE_URL = previousBaseUrl;
      await service.close();
    }
  });
});
