import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jsonSchemaAccepts } from "./helpers/json-schema.ts";
import { loadConfig } from "../src/config.js";
import { createAzureDevOpsToolDefinitions } from "../extension-packages/azure-devops-platform/plugins/azure-devops-platform/azure-devops-platform.ts";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";
import { compactParameterPolicy, normalizeParameterPolicy } from "../extension-packages/azure-devops-platform/frontend/entry.js";
import { ExtensionInstaller } from "../src/features/extensions/installer.js";
import { ExtensionManifestService } from "../src/features/extensions/extensionManifestService.js";
import { OpenCodePluginManifestService } from "../src/features/opencode-plugin-manifests/service.js";
import { createOpenCodeProjectsService } from "../src/features/opencode-projects/service.js";
import { createOpenCodeRegistryService } from "../src/features/opencode-registry/service.js";
import { createProjectOpenCodeConfigService } from "../src/features/opencode-project-config/service.js";
import { ExtensionBackendService } from "../src/features/extensions/backend.js";
import { PlatformExtensionService } from "../src/features/extensions/service.js";
import { WorkflowService } from "../src/features/workflows/service.js";
import { validateAicxtPackage } from "../src/features/extensions/packageValidation.js";
import { createDefaultAzureDevOpsParameterPolicy } from "../policy/index.ts";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const OLD_TIP = "1".repeat(40);
const NEW_TIP = "2".repeat(40);
const PAT = "pipeline-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 11).toString("base64");
const YAML_CONTENT = "trigger:\n  - main\n\npool:\n  vmImage: ubuntu-latest\n";
const TOOL = "azure_devops_publish_pipeline_yaml";
const MANAGED_PROJECT = "agent-system-project";
const PREVIEW_TOOL = "azure_devops_preview_pipeline";

test("publishes a new YAML file with Azure DevOps Git REST 7.1 branch concurrency contract", async () => {
  await withBackend(async (runtime) => {
    const requests = installAdoFixture({ branchTips: [OLD_TIP, OLD_TIP] });
    const result = await callPublish(runtime);

    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url.pathname}`), [
      `GET /${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}`,
      `GET /${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/refs`,
      `GET /${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/items`,
      `GET /${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/refs`,
      `POST /${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}/pushes`,
    ]);
    assert.equal(requests.every(({ url }) => url.searchParams.get("api-version") === "7.1"), true);
    assert.equal(requests[1]?.url.searchParams.get("filter"), "heads/main");
    assert.equal(requests[2]?.url.searchParams.get("path"), "/pipelines/release.yml");
    assert.equal(requests[2]?.url.searchParams.get("includeContent"), "true");
    assert.equal(requests[2]?.url.searchParams.get("versionDescriptor.versionType"), "commit");
    assert.equal(requests[2]?.url.searchParams.get("versionDescriptor.version"), OLD_TIP);
    assert.equal(requests[4]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
    assert.deepEqual(requests[4]?.body, {
      refUpdates: [{ name: "refs/heads/main", oldObjectId: OLD_TIP }],
      commits: [{
        comment: "Add Pipeline YAML",
        changes: [{
          changeType: "add",
          item: { path: "/pipelines/release.yml" },
          newContent: { content: YAML_CONTENT, contentType: "rawtext" },
        }],
      }],
    });
    assert.deepEqual(result, {
      branch: "main",
      commitId: NEW_TIP,
      path: "pipelines/release.yml",
      result: "created",
    });
    assert.equal(JSON.stringify(result).includes(YAML_CONTENT), false);
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET_KEY), false);
    assert.equal(requests[4]?.headers.get("x-extension-secret-key"), null);
  });
});

test("returns no-op for identical content and conflict for different existing content", async () => {
  for (const existingContent of [YAML_CONTENT, `${YAML_CONTENT}\n# different`]) {
    await withBackend(async (runtime) => {
      const requests = installAdoFixture({
        branchTips: [OLD_TIP, OLD_TIP],
        item: { path: "/pipelines/release.yml", content: existingContent, contentType: "rawText" },
      });

      if (existingContent === YAML_CONTENT) {
        assert.deepEqual(await callPublish(runtime), {
          branch: "main",
          commitId: OLD_TIP,
          path: "pipelines/release.yml",
          result: "no-op",
        });
      } else {
        await assert.rejects(
          () => callPublish(runtime),
          (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_PATH_CONFLICT"
            && (error as { statusCode?: number }).statusCode === 409
            && !errorMessage(error).includes(YAML_CONTENT),
        );
      }
      assert.equal(requests.some(({ url }) => url.pathname.endsWith("/pushes")), false);
    });
  }
});

test("rejects a changed branch tip before attempting the commit", async () => {
  await withBackend(async (runtime) => {
    const requests = installAdoFixture({ branchTips: [OLD_TIP, NEW_TIP] });
    await assert.rejects(
      () => callPublish(runtime),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_BRANCH_CONFLICT"
        && (error as { statusCode?: number }).statusCode === 409,
    );
    assert.equal(requests.some(({ url }) => url.pathname.endsWith("/pushes")), false);
  });
});

test("rejects repository metadata that does not match the selected repository identity", async () => {
  await withBackend(async (runtime) => {
    const requests = installAdoFixture({
      repository: { id: "33333333-3333-4333-8333-333333333333" },
    });
    await assert.rejects(
      () => callPublish(runtime),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_IDENTITY_MISMATCH"
        && (error as { statusCode?: number }).statusCode === 409,
    );
    assert.equal(requests.some(({ url }) => url.pathname.endsWith("/refs")), false);
  });
});

test("rejects Azure DevOps staleOldObjectId responses from the conditional Git Push", async () => {
  await withBackend(async (runtime) => {
    const requests = installAdoFixture({
      branchTips: [OLD_TIP, OLD_TIP],
      pushResponse: jsonResponse(200, {
        refUpdates: [{ name: "refs/heads/main", oldObjectId: OLD_TIP, updateStatus: "staleOldObjectId", success: false }],
      }),
    });
    await assert.rejects(
      () => callPublish(runtime),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_BRANCH_CONFLICT"
        && (error as { statusCode?: number }).statusCode === 409,
    );
    const push = requests.find(({ url }) => url.pathname.endsWith("/pushes"));
    assert.deepEqual(push?.body?.refUpdates, [{ name: "refs/heads/main", oldObjectId: OLD_TIP }]);
  });
});

test("rejects invalid paths and unbounded or empty YAML before Azure DevOps requests", async () => {
  await withBackend(async (runtime) => {
    let requestCount = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requestCount += 1;
      return jsonResponse(500, {});
    };
    try {
      for (const path of ["../release.yml", "/release.yml", "pipelines/../release.yml", "C:/release.yaml", "release.txt", "pipelines//release.yml"]) {
        await assert.rejects(
          () => callPublish(runtime, { path }),
          (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_PATH_INVALID",
        );
      }
      for (const yamlContent of ["  \n", "x".repeat(100_001), "\0invalid"]) {
        await assert.rejects(
          () => callPublish(runtime, { yamlContent }),
          (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_CONTENT_INVALID",
        );
      }
      await assert.rejects(
        () => callPublish(runtime, { repositoryID: undefined, repositoryName: undefined, repositoryReference: undefined }),
        (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_REPOSITORY_IDENTITY_INVALID",
      );
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Pipeline YAML publish repository selector errors preserve its codes and status mapping", async () => {
  const emptySelector = { repositoryID: undefined, repositoryName: undefined, repositoryReference: undefined };
  const cases = [
    {
      input: {},
      code: "ADO_PIPELINE_YAML_REPOSITORY_IDENTITY_INVALID",
      status: 400,
    },
    {
      input: { repositoryID: REPOSITORY_ID, repositoryName: "pipeline-repository" },
      code: "ADO_PIPELINE_YAML_REPOSITORY_IDENTITY_INVALID",
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
      status: 400,
    },
    {
      input: { repositoryReference: `azure-devops://${ORGANIZATION}/other-project/${REPOSITORY_ID}` },
      code: "AZURE_DEVOPS_PROJECT_MISMATCH",
      status: 400,
    },
  ];

  for (const scenario of cases) {
    await withBackend(async (runtime) => {
      const requests = installAdoFixture();
      await assert.rejects(
        () => callPublish(runtime, { ...emptySelector, ...scenario.input }),
        (error: unknown) => errorCode(error) === scenario.code
          && (error as { statusCode?: number }).statusCode === scenario.status,
      );
      assert.equal(requests.length, 0);
    });
  }
});

test("Pipeline YAML publish accepts verified ID, name, and reference repository selectors", async () => {
  const emptySelector = { repositoryID: undefined, repositoryName: undefined, repositoryReference: undefined };
  const selectors = [
    { input: { repositoryID: REPOSITORY_ID }, endpointSelector: REPOSITORY_ID },
    { input: { repositoryName: "pipeline-repository" }, endpointSelector: "pipeline-repository" },
    { input: { repositoryReference: `azure-devops://${ORGANIZATION}/${PROJECT}/${REPOSITORY_ID}` }, endpointSelector: REPOSITORY_ID },
  ];

  for (const selector of selectors) {
    await withBackend(async (runtime) => {
      const requests = installAdoFixture({ branchTips: [OLD_TIP, OLD_TIP] });
      assert.deepEqual(await callPublish(runtime, { ...emptySelector, ...selector.input }), {
        branch: "main",
        commitId: NEW_TIP,
        path: "pipelines/release.yml",
        result: "created",
      });
      assert.equal(requests[0]?.url.pathname.endsWith(`/_apis/git/repositories/${selector.endpointSelector}`), true);
      assert.equal(requests.at(-1)?.url.pathname.endsWith("/pushes"), true);
    });
  }
});

test("maps permission errors and uncertain push outcomes to bounded diagnostics", async () => {
  for (const status of [401, 403]) {
    await withBackend(async (runtime) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => jsonResponse(status, { message: `sensitive ${PAT} ${YAML_CONTENT}` });
      try {
        await assert.rejects(
          () => callPublish(runtime),
          (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_PERMISSION_DENIED"
            && (error as { statusCode?: number }).statusCode === status
            && !errorMessage(error).includes(PAT)
            && !errorMessage(error).includes(YAML_CONTENT)
            && errorMessage(error).length < 300,
        );
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  }

  await withBackend(async (runtime) => {
    const requests = installAdoFixture({
      branchTips: [OLD_TIP, OLD_TIP],
      pushResponse: jsonResponse(500, { message: `uncertain commit ${PAT} ${YAML_CONTENT}` }),
    });
    await assert.rejects(
      () => callPublish(runtime),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_PUBLISH_OUTCOME_UNKNOWN"
        && !errorMessage(error).includes(PAT)
        && !errorMessage(error).includes(YAML_CONTENT)
        && errorMessage(error).length < 300,
    );
    assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/pushes")).length, 1);
  });

  await withBackend(async (runtime) => {
    installAdoFixture({
      branchTips: [OLD_TIP, OLD_TIP],
      pushResponse: jsonResponse(403, { message: `permission failure ${PAT} ${YAML_CONTENT}` }),
    });
    await assert.rejects(
      () => callPublish(runtime),
      (error: unknown) => errorCode(error) === "ADO_PIPELINE_YAML_PERMISSION_DENIED"
        && (error as { statusCode?: number }).statusCode === 403
        && !errorMessage(error).includes(PAT)
        && !errorMessage(error).includes(YAML_CONTENT),
    );
  });
});

test("routes the Plugin Tool through project-scoped BFF policy and Extension backend to Azure DevOps REST", async () => {
  await withBackend(async () => {
    const managedProject = "agent-system-project";
    const parameterPolicy = createDefaultAzureDevOpsParameterPolicy(PROJECT);
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    const adoRequests = installAdoFixture({ branchTips: [OLD_TIP, OLD_TIP] });
    let contextProject: string | undefined;
    const service = new ExtensionBackendService(
      {
        readBackend: async () => ({
          content: await readFile(new URL("../extension-packages/azure-devops-platform/backend/entry.js", import.meta.url)),
          effectiveScope: "project",
          extensionId: "azure-devops-platform",
          packageSha256: "e".repeat(64),
          version: "1.6.46",
        }),
        readSettings: async (_extensionId: string, _scope: string, project: string) => {
          contextProject = project;
          return { azureDevOps: { organization: ORGANIZATION, project: PROJECT, parameterPolicy } };
        },
      } as never,
      [],
    );
    const previousFetch = globalThis.fetch;
    const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://pipeline-yaml-bff.test";
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/bff/extensions/azure-devops-platform/backend/")) {
        return fixtureFetch(adoRequests, url, init);
      }
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      bffRequests.push({ body, headers, url });
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
        method: init.method ?? "GET",
        params: {
          "*": url.pathname.split("/backend/")[1] ?? "",
          extensionId: "azure-devops-platform",
        },
        query: { project: url.searchParams.get("project"), scope: url.searchParams.get("scope") },
      } as never, reply as never);
      return jsonResponse(status, responseBody);
    };

    try {
      const plugin = await createAzureDevOpsToolDefinitions({ project: managedProject } as never) as unknown as Record<string, any>;
      const result = await plugin[TOOL]!.execute({
        repositoryID: REPOSITORY_ID,
        path: "pipelines/release.yml",
        yamlContent: YAML_CONTENT,
      }, { metadata: async () => undefined });

      assert.equal(contextProject, managedProject);
      assert.equal(bffRequests.length, 1);
      assert.equal(bffRequests[0]?.url.pathname, "/bff/extensions/azure-devops-platform/backend/publish-pipeline-yaml");
      assert.equal(bffRequests[0]?.url.searchParams.get("project"), managedProject);
      assert.equal(bffRequests[0]?.url.searchParams.get("scope"), "project");
      assert.equal(bffRequests[0]?.headers.get("x-agent-system-workspace"), managedProject);
      assert.equal(bffRequests[0]?.headers.get("x-extension-secret-key"), EXTENSION_SECRET_KEY);
      assert.deepEqual(bffRequests[0]?.body, {
        tool: TOOL,
        agentInput: { repositoryID: REPOSITORY_ID, path: "pipelines/release.yml", yamlContent: YAML_CONTENT },
      });
      assert.equal(adoRequests.at(-1)?.url.pathname.endsWith("/pushes"), true);
      assert.equal(adoRequests.at(-1)?.body?.refUpdates instanceof Array, true);
      assert.deepEqual(JSON.parse(result.content), {
        branch: "main",
        commitId: NEW_TIP,
        path: "pipelines/release.yml",
        result: "created",
      });
      assert.equal(result.content.includes(YAML_CONTENT), false);
      assert.equal(result.content.includes(PAT), false);
      assert.equal(result.content.includes(EXTENSION_SECRET_KEY), false);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
      await service.close();
    }
  });
});

test("project package install/update syncs both runtimes and completes the Pipeline REST workflow through the installed backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "ado-pipeline-install-integration-"));
  const archive = await readFile(new URL("../extension-packages/azure-devops-platform.aicxt", import.meta.url));
  const packageData = validateAicxtPackage(archive);
  const contributions = packageData.manifest.pluginContributions ?? [];
  const mainRuntimeServer = createPluginRuntimeServer(contributions);
  const workflowRuntimeServer = createPluginRuntimeServer(contributions);
  const restarted: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  const previousBaseUrl = process.env.AGENT_SYSTEM_BFF_BASE_URL;

  let mainRuntimeUrl = "";
  let workflowRuntimeUrl = "";
  let extensionBackend: ExtensionBackendService | undefined;
  try {
    mainRuntimeUrl = await listen(mainRuntimeServer);
    workflowRuntimeUrl = await listen(workflowRuntimeServer);
    const config = loadConfig({
      ...process.env,
      EXTENSION_PACKAGE_ROOT: join(root, "installed-packages"),
      OPENCODE_BASE_URL: mainRuntimeUrl,
      OPENCODE_DATA_ROOT: join(root, "main-data"),
      OPENCODE_GLOBAL_REGISTRY_ROOT: join(root, "main-global", ".opencode"),
      OPENCODE_PROJECT_CONFIG_PATH: join(root, "main-project", "opencode.jsonc"),
      OPENCODE_PROJECT_REGISTRY_ROOT: join(root, "main-project", ".opencode"),
      OPENCODE_PROJECT_ROOT: join(root, "main-project"),
      OPENCODE_PROJECTS_ROOT: join(root, "main-projects"),
      OPENCODE_RUNTIME_CONTROL_ENABLED: "false",
      OPENCODE_WORKFLOW_BASE_URL: workflowRuntimeUrl,
      OPENCODE_WORKFLOW_DATA_ROOT: join(root, "workflow-data"),
      OPENCODE_WORKFLOW_GLOBAL_COMMANDS_ROOT: join(root, "workflow-global", "commands"),
      OPENCODE_WORKFLOW_GLOBAL_REGISTRY_ROOT: join(root, "workflow-global", ".opencode"),
      OPENCODE_WORKFLOW_PROJECT_CONFIG_PATH: join(root, "workflow-project", "opencode.jsonc"),
      OPENCODE_WORKFLOW_PROJECT_REGISTRY_ROOT: join(root, "workflow-project", ".opencode"),
      OPENCODE_WORKFLOW_PROJECT_ROOT: join(root, "workflow-project"),
      OPENCODE_WORKFLOW_PROJECTS_ROOT: join(root, "workflow-projects"),
      PLATFORM_EXTENSIONS_PATH: join(root, "extension-manifests.json"),
    });
    const registry = createOpenCodeRegistryService(config);
    const projectConfig = createProjectOpenCodeConfigService(config);
    const projects = createOpenCodeProjectsService(config);
    const runtime = (target: string) => ({
      isEnabled: () => true,
      restart: async ({ reason }: { reason: string }) => {
        restarted.push(`${target}:${reason}`);
        return { status: "ready" as const };
      },
    });
    const workflows = new WorkflowService(config, registry, projectConfig, runtime("main") as never, projects, runtime("workflow-test") as never);
    const pluginManifests = new OpenCodePluginManifestService(config, workflows);
    workflows.setPluginManifestCatalog(pluginManifests);
    const extensions = new PlatformExtensionService(config, registry, projectConfig, workflows);
    extensionBackend = new ExtensionBackendService(extensions);
    const installer = new ExtensionInstaller(extensions, extensionBackend, runtime("main") as never, pluginManifests);

    await projects.create({
      description: "Project used by the Pipeline install integration fixture.",
      displayName: MANAGED_PROJECT,
      initializeReadme: false,
      name: MANAGED_PROJECT,
      overwrite: false,
    });

    const installed = await installer.installArchive({
      archive,
      extend: false,
      filename: "azure-devops-platform.aicxt",
      project: MANAGED_PROJECT,
      scope: "project",
    });
    assert.deepEqual(installed.pluginRuntimeReadiness?.requiredTargets, ["main", "workflow-test"]);
    assert.deepEqual(installed.pluginRuntimeReadiness?.verifiedTargets, ["main", "workflow-test"]);
    assert.equal(installed.workflowSync?.plugins.synchronized, true);

    const mainPluginEntry = await readFile(join(config.openCodeProjectsRoot, MANAGED_PROJECT, ".opencode", "plugins", "azure-devops-platform.ts"), "utf8");
    const workflowPluginEntry = await readFile(join(config.workflowProjectsRoot, MANAGED_PROJECT, ".opencode", "plugins", "azure-devops-platform.ts"), "utf8");
    assert.equal(workflowPluginEntry, mainPluginEntry);

    const fullParameterPolicy = normalizeParameterPolicy({
      version: 1,
      tools: {
        azure_devops_preview_pipeline: {
          fields: { branchRef: { mode: "fixed", value: "refs/heads/main" } },
        },
      },
    }, PROJECT);
    const parameterPolicy = compactParameterPolicy(fullParameterPolicy, PROJECT);
    assert.deepEqual(parameterPolicy, {
      version: 1,
      tools: { azure_devops_preview_pipeline: { fields: { branchRef: { mode: "fixed", value: "refs/heads/main" } } } },
    });
    const contextDocument = { organization: ORGANIZATION, project: PROJECT, parameterPolicy };
    assert.ok(Buffer.byteLength(JSON.stringify(contextDocument), "utf8") < 4_096);
    const manifestStore = new ExtensionManifestService(config);
    const installedManifest = await manifestStore.read("project", "azure-devops-platform", MANAGED_PROJECT);
    assert.ok(installedManifest);
    await manifestStore.write({
      ...installedManifest,
      version: "1.6.44",
      packageSha256: "a".repeat(64),
      resources: [...installedManifest.resources, {
        kind: "mcp",
        name: "azure-devops",
        path: "mcp/azure-devops.json",
        configNames: ["azure-devops"],
      }],
      pluginContributions: (installedManifest.pluginContributions ?? []).map((declaration) => (
        declaration.pluginName === "azure-devops-platform"
          ? { ...declaration, contributions: [...declaration.contributions, { kind: "mcp" as const, name: "azure-devops" }] }
          : declaration
      )),
    });
    const initialConfig = await projectConfig.read("project", MANAGED_PROJECT);
    const currentMcp = asRecord(initialConfig.config.mcp) ?? {};
    const configuredMcp = {
      ...currentMcp,
      "azure-devops": {
        type: "local",
        command: ["node", "azure-devops-mcp-bridge", ORGANIZATION],
        enabled: true,
        environment: { ado_mcp_context: JSON.stringify(contextDocument), ado_mcp_project: PROJECT },
      },
    };
    await projectConfig.apply("project", MANAGED_PROJECT, { mcp: configuredMcp });
    await workflows.syncMainConfigToWorkflowTest({
      body: { mcp: configuredMcp, restartWorkflowTest: false },
      project: MANAGED_PROJECT,
      scope: "project",
    });

    const updated = await installer.installArchive({
      archive,
      extend: true,
      filename: "azure-devops-platform.aicxt",
      project: MANAGED_PROJECT,
      scope: "project",
    });
    assert.equal(updated.manifest.version, packageData.manifest.version);
    assert.deepEqual(updated.pluginRuntimeReadiness?.verifiedTargets, ["main", "workflow-test"]);
    assert.deepEqual(updated.pluginRuntimeReadiness?.requiredTargets, ["main", "workflow-test"]);
    assert.equal(updated.manifest.resources.some((resource) => resource.kind === "mcp"), false);
    assert.equal(updated.manifest.pluginContributions?.some((declaration) => declaration.contributions.some((contribution) => contribution.kind === "mcp")), false);
    const migratedContext = (await extensions.readSettings("azure-devops-platform", "project", MANAGED_PROJECT)).azureDevOps as Record<string, any>;
    assert.equal(migratedContext.organization, ORGANIZATION);
    assert.equal(migratedContext.project, PROJECT);
    assert.deepEqual(migratedContext.parameterPolicy.tools.azure_devops_preview_pipeline.fields.branchRef, {
      mode: "fixed",
      value: "refs/heads/main",
    });
    assert.ok(migratedContext.parameterPolicy.tools.azure_devops_update_work_item);

    const mainConfigAfterUpdate = await projectConfig.read("project", MANAGED_PROJECT);
    assert.equal(asRecord(mainConfigAfterUpdate.config.mcp)?.["azure-devops"], undefined);
    const workflowConfigAfterUpdate = JSON.parse(await readFile(join(config.workflowProjectsRoot, MANAGED_PROJECT, "opencode.jsonc"), "utf8")) as Record<string, unknown>;
    assert.equal(asRecord(workflowConfigAfterUpdate.mcp)?.["azure-devops"], undefined);

    for (const target of ["main", "workflow-test"] as const) {
      const catalog = await pluginManifests.readPluginContributionCatalog(MANAGED_PROJECT, target);
      const azureCatalog = catalog.find((entry) => entry.pluginName === "azure-devops-platform");
      assert.equal(azureCatalog?.status, "verified", `${target} Plugin contribution catalog should be ready`);
      assert.equal(azureCatalog?.contributions.tools.some((tool) => tool.name === PREVIEW_TOOL), true);
      assert.equal(azureCatalog?.contributions.tools.some((tool) => tool.name === "azure_devops_create_repository"), true);
      assert.deepEqual(azureCatalog?.contributions.mcp, []);
    }
    for (const [target, server] of [["main", mainRuntimeServer], ["workflow-test", workflowRuntimeServer]] as const) {
      const targetRoot = target === "main" ? config.openCodeProjectsRoot : config.workflowProjectsRoot;
      const projectDirectory = join(targetRoot, MANAGED_PROJECT).replace(/\\/g, "/");
      const otherTargetRoot = (target === "main" ? config.workflowProjectsRoot : config.openCodeProjectsRoot).replace(/\\/g, "/");
      assert.ok(server.requests.some(({ pathname, method, directory, queryDirectory }) => pathname === "/api/rpc/agent-system-workflow/catalog"
        && method === "POST"
        && directory === projectDirectory
        && queryDirectory === projectDirectory), `${target} runtime must receive V2 POST catalog RPC with location[directory]=${projectDirectory}; received ${JSON.stringify(server.requests)}`);
      assert.ok(server.requests.every(({ directory }) => directory.replace(/\\/g, "/").startsWith(otherTargetRoot) === false), `${target} runtime must not receive the other target's directory`);
    }
    const workflowCatalog = await workflows.catalog(MANAGED_PROJECT, true, MANAGED_PROJECT);
    assert.equal(workflowCatalog.resources.tools.find((resource) => resource.name === PREVIEW_TOOL)?.availability, "available");

    mainRuntimeServer.blockCatalog = true;
    const catalogRequestsBeforeAbort = mainRuntimeServer.requests.filter(({ pathname }) => pathname === "/api/rpc/agent-system-workflow/catalog").length;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(new DOMException("fixture test cancelled", "AbortError")), 50);
    try {
      await assert.rejects(
        workflows.readWorkflowRuntimeSnapshot("main", MANAGED_PROJECT, abortController.signal),
        (error: unknown) => error instanceof DOMException && error.name === "AbortError",
      );
    } finally {
      clearTimeout(abortTimer);
      mainRuntimeServer.blockCatalog = false;
    }
    assert.equal(mainRuntimeServer.requests.filter(({ pathname }) => pathname === "/api/rpc/agent-system-workflow/catalog").length, catalogRequestsBeforeAbort + 1,
      "the aborted RPC must not be retried after its AbortSignal fires");

    process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET_KEY;
    process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
    process.env.AGENT_SYSTEM_BFF_BASE_URL = "http://pipeline-install-bff.test";
    await dispatchExtensionBackend(extensionBackend, "store-credential", {
      organization: ORGANIZATION,
      project: PROJECT,
      token: PAT,
    }, MANAGED_PROJECT, { "x-extension-secret-key": EXTENSION_SECRET_KEY });

    const existingPipelineID = 42;
    const pipelineID = 43;
    const runID = 57;
    const existingPipelineName = "Existing YAML Pipeline";
    const pipelineName = "Build from submitted YAML";
    const existingYamlPath = "pipelines/existing.yml";
    const publishedYamlPath = "pipelines/install-created.yml";
    let yamlPublished = false;
    const createdDefinitions: Array<{ configuration: unknown; folder: string; id: number; name: string }> = [];
    const adoRequests: Array<{ body: Record<string, unknown>; headers: Headers; method: string; url: URL }> = [];
    const bffRequests: Array<{ body: Record<string, unknown>; headers: Headers; url: URL }> = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "pipeline-install-bff.test") {
        const headers = new Headers(init.headers);
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        bffRequests.push({ body, headers, url });
        const backendResponse = await dispatchExtensionBackend(
          extensionBackend!,
          url.pathname.split("/backend/")[1] ?? "",
          body,
          url.searchParams.get("project") ?? "",
          Object.fromEntries(headers.entries()),
          url.searchParams.get("scope") ?? "project",
          init.method ?? "POST",
        );
        return jsonResponse(backendResponse.status, backendResponse.body);
      }
      if (url.hostname === "dev.azure.com") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        const method = init.method ?? "GET";
        adoRequests.push({ body, headers: new Headers(init.headers), method, url });
        if (url.pathname === `/${ORGANIZATION}/_apis/projects/${PROJECT}`) {
          return jsonResponse(200, { id: PROJECT_ID, name: PROJECT });
        }
        if (url.pathname === `/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY_ID}`) {
          return jsonResponse(200, {
            id: REPOSITORY_ID,
            name: "pipeline-repository",
            project: { id: PROJECT_ID, name: PROJECT },
            remoteUrl: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_git/pipeline-repository`,
            defaultBranch: "refs/heads/main",
          });
        }
        if (url.pathname.endsWith("/refs")) {
          return jsonResponse(200, { value: [{ name: "refs/heads/main", objectId: OLD_TIP }] });
        }
        if (url.pathname.endsWith("/items")) {
          const itemPath = url.searchParams.get("path");
          const exists = itemPath === `/${existingYamlPath}`
            || (itemPath === `/${publishedYamlPath}` && yamlPublished);
          if (!exists) return jsonResponse(404, { typeKey: "GitItemNotFoundException" });
          return jsonResponse(200, {
            path: itemPath,
            isFolder: false,
            ...(url.searchParams.get("includeContent") === "true" ? { content: itemPath === `/${publishedYamlPath}` ? YAML_CONTENT : "existing pipeline YAML", contentType: "rawText" } : {}),
          });
        }
        if (url.pathname.endsWith("/pushes")) {
          yamlPublished = true;
          return jsonResponse(200, {
            commits: [{ commitId: NEW_TIP }],
            refUpdates: [{ name: "refs/heads/main", oldObjectId: OLD_TIP, newObjectId: NEW_TIP, updateStatus: "succeeded", success: true }],
          });
        }
        if (url.pathname === `/${ORGANIZATION}/${PROJECT}/_apis/pipelines`) {
          if (method === "POST") {
            const configuration = asRecord(body.configuration) ?? {};
            const yamlPath = typeof configuration.path === "string" ? configuration.path : "";
            const id = yamlPath === `/${existingYamlPath}` ? existingPipelineID : pipelineID;
            const name = typeof body.name === "string" ? body.name : pipelineName;
            const folder = typeof body.folder === "string" ? body.folder : "\\";
            const created = { id, name, folder, configuration: body.configuration };
            createdDefinitions.push(created);
            return jsonResponse(201, created);
          }
          return jsonResponse(200, {
            count: createdDefinitions.length,
            value: createdDefinitions.map(({ id, name, folder }) => ({ id, name, folder })),
          });
        }
        if (url.pathname === `/${ORGANIZATION}/${PROJECT}/_apis/pipelines/${pipelineID}/runs` && method === "POST") {
          if (body.previewRun === true) {
            return jsonResponse(200, {
              finalYaml: [
                "variables:",
                "  - { name: release-label, value: preview-flow-secret, isSecret: true }",
              ].join("\n"),
            });
          }
          return jsonResponse(200, {
            id: runID,
            name: "20261003.1",
            pipeline: { id: pipelineID, name: pipelineName },
            state: "inProgress",
            result: "unknown",
            createdDate: "2026-10-03T12:00:00Z",
          });
        }
        if (url.pathname === `/${ORGANIZATION}/${PROJECT}/_apis/pipelines/${pipelineID}/runs/${runID}` && method === "GET") {
          return jsonResponse(200, {
            id: runID,
            name: "20261003.1",
            pipeline: { id: pipelineID, name: pipelineName },
            state: "completed",
            result: "succeeded",
            createdDate: "2026-10-03T12:00:00Z",
            finishedDate: "2026-10-03T12:05:00Z",
          });
        }
        return jsonResponse(404, {});
      }
      return previousFetch(input, init);
    };

    const plugin = await createAzureDevOpsToolDefinitions({ project: MANAGED_PROJECT } as never) as unknown as Record<string, any>;
    const toolContext = { metadata: async () => undefined };
    const existingCreated = JSON.parse((await plugin.azure_devops_create_pipeline!.execute({
      repositoryID: REPOSITORY_ID,
      name: existingPipelineName,
      yamlPath: existingYamlPath,
    }, toolContext)).content) as { created: boolean; alreadyExists: boolean; pipeline: { id: number; yamlPath: string } };
    assert.equal(existingCreated.created, true);
    assert.equal(existingCreated.alreadyExists, false);
    assert.equal(existingCreated.pipeline.id, existingPipelineID);
    assert.equal(existingCreated.pipeline.yamlPath, existingYamlPath);

    const publish = JSON.parse((await plugin.azure_devops_publish_pipeline_yaml!.execute({
      repositoryID: REPOSITORY_ID,
      path: publishedYamlPath,
      yamlContent: YAML_CONTENT,
    }, toolContext)).content) as { branch: string; commitId: string; path: string; result: string };
    assert.deepEqual(publish, { branch: "main", commitId: NEW_TIP, path: publishedYamlPath, result: "created" });
    const created = JSON.parse((await plugin.azure_devops_create_pipeline!.execute({
      repositoryID: REPOSITORY_ID,
      name: pipelineName,
      yamlPath: publishedYamlPath,
    }, toolContext)).content) as { created: boolean; alreadyExists: boolean; pipeline: { id: number; yamlPath: string } };
    assert.equal(created.created, true);
    assert.equal(created.alreadyExists, false);
    assert.equal(created.pipeline.id, pipelineID);
    assert.equal(created.pipeline.yamlPath, publishedYamlPath);
    const listed = JSON.parse((await plugin.azure_devops_list_pipelines!.execute({}, toolContext)).content) as {
      count: number;
      pipelines: Array<{ folder: string; id: number; name: string }>;
    };
    assert.deepEqual(listed, {
      count: 2,
      pipelines: [
        { id: existingPipelineID, name: existingPipelineName, folder: "\\" },
        { id: pipelineID, name: pipelineName, folder: "\\" },
      ],
    });

    const previewResult = await plugin[PREVIEW_TOOL]!.execute({ pipelineId: pipelineID }, toolContext);
    const preview = JSON.parse(previewResult.content) as { finalYaml: string; pipelineId: number; previewOnly: boolean; truncated: boolean };
    assert.equal(preview.previewOnly, true);
    assert.equal(preview.truncated, false);
    assert.equal(preview.pipelineId, pipelineID);
    assert.equal(preview.finalYaml.includes("preview-flow-secret"), false);
    assert.match(preview.finalYaml, /value: "\[REDACTED\]"/);

    const run = JSON.parse((await plugin.azure_devops_run_pipeline!.execute({
      pipelineId: pipelineID,
      branchRef: "refs/heads/release/2026",
    }, toolContext)).content) as { id: number; pipelineId: number; state: string };
    assert.deepEqual(run, {
      id: runID,
      pipelineId: pipelineID,
      pipelineName,
      name: "20261003.1",
      state: "inProgress",
      result: "unknown",
      createdDate: "2026-10-03T12:00:00Z",
    });
    const status = JSON.parse((await plugin.azure_devops_get_pipeline_run!.execute({
      pipelineId: pipelineID,
      runId: runID,
    }, toolContext)).content) as { id: number; pipelineId: number; state: string; result: string };
    assert.deepEqual(status, {
      id: runID,
      pipelineId: pipelineID,
      pipelineName,
      name: "20261003.1",
      state: "completed",
      result: "succeeded",
      createdDate: "2026-10-03T12:00:00Z",
      finishedDate: "2026-10-03T12:05:00Z",
    });

    assert.deepEqual(bffRequests.map(({ url }) => url.pathname.split("/backend/")[1]), [
      "create-pipeline",
      "publish-pipeline-yaml",
      "create-pipeline",
      "list-pipelines",
      "preview-pipeline",
      "run-pipeline",
      "get-pipeline-run",
    ]);
    assert.equal(bffRequests.every(({ url, headers }) => url.searchParams.get("project") === MANAGED_PROJECT
      && url.searchParams.get("scope") === "project"
      && headers.get("x-agent-system-workspace") === MANAGED_PROJECT
      && headers.get("x-extension-secret-key") === EXTENSION_SECRET_KEY), true);
    assert.deepEqual(bffRequests[0]?.body, {
      tool: "azure_devops_create_pipeline",
      agentInput: { repositoryID: REPOSITORY_ID, name: existingPipelineName, yamlPath: existingYamlPath },
    });
    assert.deepEqual(bffRequests[1]?.body, {
      tool: TOOL,
      agentInput: { repositoryID: REPOSITORY_ID, path: publishedYamlPath, yamlContent: YAML_CONTENT },
    });

    const push = adoRequests.find(({ url }) => url.pathname.endsWith("/pushes"));
    assert.deepEqual(push?.body?.refUpdates, [{ name: "refs/heads/main", oldObjectId: OLD_TIP }]);
    const createRequests = adoRequests.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/_apis/pipelines"));
    const createdYamlPaths = createRequests.map((request) => asRecord(request.body.configuration)?.path);
    assert.deepEqual(createdYamlPaths, [
      `/${existingYamlPath}`,
      `/${publishedYamlPath}`,
    ]);
    assert.equal(createRequests.every(({ body }) => JSON.stringify(body.configuration ?? {}).includes(REPOSITORY_ID)), true);
    assert.equal(adoRequests.filter(({ method, url }) => method === "GET" && url.pathname.endsWith("/_apis/pipelines")).length, 3);
    const runRequests = adoRequests.filter(({ method, url }) => method === "POST" && url.pathname.endsWith(`/pipelines/${pipelineID}/runs`));
    assert.deepEqual(runRequests.map(({ body }) => body.previewRun), [true, false]);
    assert.deepEqual(runRequests[1]?.body, {
      previewRun: false,
      resources: { repositories: { self: { refName: "refs/heads/release/2026" } } },
    });
    const statusRequest = adoRequests.find(({ method, url }) => method === "GET" && url.pathname.endsWith(`/pipelines/${pipelineID}/runs/${runID}`));
    assert.equal(statusRequest?.url.searchParams.get("api-version"), "7.1");
    assert.equal(adoRequests.every(({ headers }) => headers.get("authorization") === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`), true);
    assert.equal(JSON.stringify({ publish, created, listed, preview, run, status }).includes(PAT), false);
    assert.equal(JSON.stringify({ publish, created, listed, preview, run, status }).includes(EXTENSION_SECRET_KEY), false);
    assert.equal(restarted.some((entry) => entry.startsWith("main:")), true);
    assert.equal(restarted.some((entry) => entry.startsWith("workflow-test:")), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
    restoreEnvironment("ADO_CREDENTIAL_STORE_PATH", previousStorePath);
    restoreEnvironment("AGENT_SYSTEM_BFF_BASE_URL", previousBaseUrl);
    await extensionBackend?.close();
    await closeServer(mainRuntimeServer);
    await closeServer(workflowRuntimeServer);
    await rm(root, { force: true, recursive: true });
  }
});

test("Plugin tool schema bounds repository identity, repository-relative YAML path, and YAML content", async () => {
  const plugin = createAzureDevOpsToolDefinitions({});
  const tool = plugin[TOOL];
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.input.properties), ["project", "repositoryReference", "repositoryID", "repositoryName", "path", "yamlContent"]);
  const path = tool.input.properties.path;
  assert.equal(jsonSchemaAccepts(path, "pipelines/release.yml"), true);
  assert.equal(jsonSchemaAccepts(path, "../release.yml"), false);
  assert.equal(jsonSchemaAccepts(path, "/release.yml"), false);
  assert.equal(jsonSchemaAccepts(path, "release.txt"), false);
  const repositoryID = tool.input.properties.repositoryID;
  assert.equal(jsonSchemaAccepts(repositoryID, REPOSITORY_ID), true);
  assert.equal(jsonSchemaAccepts(repositoryID, "not-a-uuid"), false);
  const repositoryName = tool.input.properties.repositoryName;
  assert.equal(jsonSchemaAccepts(repositoryName, "repo".repeat(33)), false);
  const content = tool.input.properties.yamlContent;
  assert.equal(jsonSchemaAccepts(content, YAML_CONTENT), true);
  assert.equal(jsonSchemaAccepts(content, undefined), false);
  assert.equal(jsonSchemaAccepts(content, "  \n"), false);
  assert.equal(jsonSchemaAccepts(content, "x".repeat(100_001)), false);
  assert.deepEqual(tool.input.required, ["yamlContent"]);
});

async function withBackend(run: (runtime: { handle: (input: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-pipeline-yaml-backend-"));
  const previousFetch = globalThis.fetch;
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
    globalThis.fetch = previousFetch;
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
    restoreEnvironment("ADO_CREDENTIAL_STORE_PATH", previousStorePath);
    await rm(root, { force: true, recursive: true });
  }
}

async function callPublish(
  runtime: { handle: (input: unknown) => Promise<unknown> },
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const parameters = Object.fromEntries(Object.entries({
    organization: ORGANIZATION,
    project: PROJECT,
    repositoryID: REPOSITORY_ID,
    path: "pipelines/release.yml",
    yamlContent: YAML_CONTENT,
    ...overrides,
  }).filter(([, value]) => value !== undefined));
  const response = await runtime.handle({ request: {
    path: "publish-pipeline-yaml",
    method: "POST",
    body: { tool: TOOL },
    headers: { "x-extension-secret-key": EXTENSION_SECRET_KEY },
    extensionContext: {
      azureDevOps: {
        effectiveContext: {
          organization: ORGANIZATION,
          adoProject: PROJECT,
          parameterPolicy: createDefaultAzureDevOpsParameterPolicy(PROJECT),
        },
        resolvedToolCall: { tool: TOOL, parameters },
      },
    },
  } });
  return (response as { body: unknown }).body;
}

type RecordedRequest = {
  body?: Record<string, unknown>;
  headers: Headers;
  method: string;
  url: URL;
};

function installAdoFixture(options: {
  branchTips?: string[];
  item?: Record<string, unknown>;
  pushResponse?: Response;
  repository?: Record<string, unknown>;
} = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const branchTips = [...(options.branchTips ?? [OLD_TIP, OLD_TIP])];
  globalThis.fetch = async (input, init = {}) => fixtureFetch(requests, new URL(String(input)), init, { ...options, branchTips });
  return requests;
}

async function fixtureFetch(
  requests: RecordedRequest[],
  url: URL,
  init: RequestInit,
  options: { branchTips?: string[]; item?: Record<string, unknown>; pushResponse?: Response; repository?: Record<string, unknown> } = {},
): Promise<Response> {
  const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  const request = { body, headers: new Headers(init.headers), method: init.method ?? "GET", url };
  requests.push(request);
  if (/\/_apis\/git\/repositories\/[^/]+$/.test(url.pathname)) {
    return jsonResponse(200, {
      id: REPOSITORY_ID,
      name: "pipeline-repository",
      project: { id: PROJECT_ID, name: PROJECT },
      remoteUrl: `https://dev.azure.com/${ORGANIZATION}/${PROJECT}/_git/pipeline-repository`,
      defaultBranch: "refs/heads/main",
      ...options.repository,
    });
  }
  if (url.pathname.endsWith("/refs")) {
    const objectId = options.branchTips?.shift() ?? OLD_TIP;
    return jsonResponse(200, { value: [{ name: "refs/heads/main", objectId }] });
  }
  if (url.pathname.endsWith("/items")) {
    return options.item
      ? jsonResponse(200, options.item)
      : jsonResponse(404, { typeKey: "GitItemNotFoundException" });
  }
  if (url.pathname.endsWith("/pushes")) {
    return options.pushResponse ?? jsonResponse(200, {
      commits: [{ commitId: NEW_TIP }],
      refUpdates: [{ name: "refs/heads/main", oldObjectId: OLD_TIP, newObjectId: NEW_TIP, updateStatus: "succeeded", success: true }],
    });
  }
  return jsonResponse(404, {});
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PluginRuntimeRequest = { directory: string; method: string; pathname: string; queryDirectory: string | null };

function createPluginRuntimeServer(
  pluginContributions: Array<{ pluginName: string; contributions: Array<{ kind: string; name: string }> }>,
): Server & { requests: PluginRuntimeRequest[]; blockCatalog: boolean } {
  const requests: PluginRuntimeRequest[] = [];
  const state = { blockCatalog: false };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://opencode-runtime.test");
    const directory = url.searchParams.get("location[directory]")
      ?? request.headers["x-opencode-directory"]
      ?? url.searchParams.get("directory")
      ?? "";
    requests.push({ directory, method: request.method ?? "GET", pathname: url.pathname, queryDirectory: url.searchParams.get("location[directory]") });
    void readRuntimeProjectConfig(directory).then(async (config) => {
      const pluginEntries = Array.isArray(config.plugin) ? config.plugin.filter((entry): entry is string => typeof entry === "string") : [];
      const pluginPath = directory
        ? join(directory, ".opencode", "plugins", "azure-devops-platform.ts")
        : "";
      let pluginInstalled = false;
      if (pluginPath && pluginEntries.some((entry) => entry.replaceAll("\\", "/").includes("azure-devops-platform"))) {
        try {
          await readFile(pluginPath, "utf8");
          pluginInstalled = true;
        } catch {
          pluginInstalled = false;
        }
      }
      const pluginResources = pluginInstalled
        ? pluginContributions.find((entry) => entry.pluginName === "azure-devops-platform")?.contributions ?? []
        : [];
      const catalogRPC = url.pathname === "/api/rpc/agent-system-workflow/catalog";
      if (catalogRPC && state.blockCatalog) {
        await new Promise<void>((resolve) => response.once("close", resolve));
        return;
      }
      const payload = catalogRPC
        ? { output: { pluginIDs: pluginInstalled ? ["azure-devops-platform"] : [], tools: pluginResources.filter((resource) => resource.kind === "tool").map((resource) => resource.name) } }
        : url.pathname.includes("/tool")
        ? pluginResources.filter((resource) => resource.kind === "tool").map((resource) => resource.name)
        : url.pathname.includes("/skill")
          ? pluginResources.filter((resource) => resource.kind === "skill").map((resource) => ({ name: resource.name }))
          : url.pathname.includes("/agent")
            ? []
            : url.pathname.includes("/command")
              ? []
              : url.pathname.includes("/mcp")
                ? Object.fromEntries(Object.keys(asRecord(config.mcp) ?? {}).map((name) => [name, { status: "connected" }]))
                : config;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    }).catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Runtime fixture could not read project state" }));
    });
  });
  Object.assign(server, { requests });
  Object.defineProperty(server, "blockCatalog", {
    configurable: true,
    get: () => state.blockCatalog,
    set: (value: boolean) => { state.blockCatalog = value; },
  });
  return server as Server & { requests: PluginRuntimeRequest[]; blockCatalog: boolean };
}

async function readRuntimeProjectConfig(directory: string): Promise<Record<string, unknown>> {
  if (!directory) return {};
  try {
    return asRecord(JSON.parse(await readFile(join(directory, "opencode.jsonc"), "utf8"))) ?? {};
  } catch {
    return {};
  }
}

async function dispatchExtensionBackend(
  service: ExtensionBackendService,
  path: string,
  body: Record<string, unknown>,
  project: string,
  headers: Record<string, string> = {},
  scope = "project",
  method = "POST",
): Promise<{ body: unknown; status: number }> {
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
    headers,
    method,
    params: { "*": path, extensionId: "azure-devops-platform" },
    query: { project, scope },
  } as never, reply as never);
  return { body: responseBody, status };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
