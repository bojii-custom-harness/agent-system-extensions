import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PlatformExtensionService } from "../src/features/extensions/service.js";
import { HttpError } from "../src/shared/errors.js";
import { matchesSha256Integrity, validateAicxtPackage, validateDeclaredPackageIntegrity, validatePluginRelativeDependencies } from "../src/features/extensions/packageValidation.js";

test(".aicxt manifest integrity validates every declared relative asset, not only the entry", () => {
  const files = new Map([["backend/entry.js", Buffer.from("hello")]]);
  assert.throws(
    () => validateDeclaredPackageIntegrity(files, { "backend/entry.js": "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", "backend/relative-helper.js": "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }, "backend"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_BACKEND_ASSET_MISSING",
  );
  assert.throws(
    () => validateDeclaredPackageIntegrity(new Map([["backend/relative-helper.js", Buffer.from("tampered")]]), { "backend/relative-helper.js": "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }, "backend"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_BACKEND_ASSET_INTEGRITY_INVALID",
  );
});

test(".aicxt Plugin replay rejects a relative import whose companion file was omitted", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function", "Plugin package validation must check replayable relative imports");
  assert.throws(() => validate!(new Map([
    ["plugins/sample/index.ts", Buffer.from('import { run } from "./lib/run.ts"; export { run };')],
  ]), ["plugins/sample/index.ts"]), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_MISSING");
    assert.deepEqual((error as { details?: unknown }).details, {
      importer: "plugins/sample/index.ts",
      specifier: "./lib/run.ts",
      resolvedPath: "plugins/sample/lib/run.ts",
    });
    return true;
  });
});

test(".aicxt Plugin dependencies reject non-literal import and require expressions", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function");
  for (const source of [
    'const moduleName = "./missing.ts"; await import(moduleName);',
    'const moduleName = "./missing.cjs"; require("./" + moduleName);',
  ]) {
    assert.throws(() => validate!(new Map([["plugins/sample/index.ts", Buffer.from(source)]]), ["plugins/sample/index.ts"]), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
      return true;
    });
  }
});

test(".aicxt Plugin dependency closure rejects dynamic module.require, createRequire, eval, and Function loaders", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function");
  for (const source of [
    'module.require("./" + dependency);',
    'import { createRequire } from "node:module"; const localRequire = createRequire(import.meta.url); localRequire(dependency);',
    'const localRequire = require("node:module").createRequire(import.meta.url); localRequire(dependency);',
    'eval("require(\\\"./hidden.cjs\\\")");',
    'new Function("return import(\\\"./hidden.js\\\")")();',
  ]) {
    assert.throws(() => validate!(new Map([["plugins/sample/index.ts", Buffer.from(source)]]), ["plugins/sample/index.ts"]), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
      return true;
    }, source);
  }
});

test(".aicxt Plugin dependency closure fails closed on direct aliases of dynamic loaders", async () => {
  for (const source of [
    'const load = eval; load("require(\\"./hidden.js\\")");',
    'const DynamicFunction = Function; new DynamicFunction("return import(\\"./hidden.js\\")")();',
    'const localRequire = require; localRequire(dependency);',
    'import { createRequire } from "node:module"; const makeRequire = createRequire; makeRequire(import.meta.url)(dependency);',
  ]) {
    assert.throws(() => validatePluginRelativeDependencies(
      new Map([["plugins/sample/index.ts", Buffer.from(source)]]),
      ["plugins/sample/index.ts"],
    ), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
      return true;
    }, source);
  }
});

test(".aicxt Plugin dependency alias closure is independent of declaration order", () => {
  for (const source of [
    'const first = second; const second = eval; first("require(\\"./hidden.js\\")");',
    'const first = second; const second = Function; new first("return import(\\"./hidden.js\\")")();',
    'const first = second; const second = require; first(dependency);',
    'import { createRequire } from "node:module"; const first = second; const second = createRequire; first(import.meta.url)(dependency);',
  ]) {
    assert.throws(() => validatePluginRelativeDependencies(
      new Map([["plugins/sample/index.ts", Buffer.from(source)]]),
      ["plugins/sample/index.ts"],
    ), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
      return true;
    }, source);
  }
});

test(".aicxt Plugin dependency alias closure follows identifier assignment writes", () => {
  for (const source of [
    'let first; const second = eval; first = second; first("require(\\"./hidden.js\\")");',
    'let first; const second = Function; first = second; new first("return import(\\"./hidden.js\\")")();',
    'let first; const second = require; first = second; first(dependency);',
    'import { createRequire } from "node:module"; let first; const second = createRequire; first = second; first(import.meta.url)(dependency);',
  ]) {
    assert.throws(() => validatePluginRelativeDependencies(
      new Map([["plugins/sample/index.ts", Buffer.from(source)]]),
      ["plugins/sample/index.ts"],
    ), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
      return true;
    }, source);
  }
});

test(".aicxt Plugin dependency alias closure ignores unrelated identifier assignments", () => {
  assert.doesNotThrow(() => validatePluginRelativeDependencies(new Map([
    ["plugins/sample/index.ts", Buffer.from("let first; const second = () => true; first = second; first();")],
  ]), ["plugins/sample/index.ts"]));
});

test(".aicxt Plugin dependency closure resolves literal module.require and createRequire companions", async () => {
  const files = new Map([
    ["plugins/sample/index.ts", Buffer.from([
      'module.require("./helper.ts");',
      'import { createRequire as makeRequire } from "node:module";',
      'const importedRequire = makeRequire(import.meta.url); importedRequire("./helper.ts");',
      'const commonJsRequire = require("node:module").createRequire(import.meta.url); commonJsRequire("./helper.ts");',
    ].join("\n"))],
    ["plugins/sample/helper.ts", Buffer.from("export const helper = true;")],
  ]);
  assert.doesNotThrow(() => validatePluginRelativeDependencies(files, [...files.keys()]));
});

test(".aicxt Plugin dependency scanning ignores comments and ordinary strings", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function");
  assert.doesNotThrow(() => validate!(new Map([["plugins/sample/index.ts", Buffer.from([
    '// import "./comment-only.ts"',
    '/* require("./comment-block.cjs") */',
    'const example = `import("./template-text.ts")`;',
    'const text = "require(\\\"./string-only.cjs\\\")";',
    'export const ready = true;',
  ].join("\n"))]]), ["plugins/sample/index.ts"]));
});

test(".aicxt Plugin dependency scanner rejects Windows-style relative imports instead of skipping them", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function");
  assert.throws(() => validate!(new Map([
    ["plugins/sample/index.ts", Buffer.from('import { run } from ".\\\\helper.ts";')],
  ]), ["plugins/sample/index.ts"]), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_UNRESOLVED");
    return true;
  });
});

test(".aicxt Plugin dependencies support bounded ../ and extensionless index companions but reject traversal", async () => {
  const validation = await import("../src/features/extensions/packageValidation.js") as unknown as Record<string, unknown>;
  const validate = validation.validatePluginRelativeDependencies as ((files: Map<string, Buffer>, pluginFiles: string[]) => void) | undefined;
  assert.equal(typeof validate, "function");
  const files = new Map([
    ["plugins/sample.ts", Buffer.from('import "./sample/lib";')],
    ["plugins/sample/lib/index.ts", Buffer.from('import "../shared.ts";')],
    ["plugins/sample/shared.ts", Buffer.from("export const value = 1;")],
  ]);
  assert.doesNotThrow(() => validate!(files, [...files.keys()]));

  const escapingFiles = new Map([
    ["plugins/sample.ts", Buffer.from('import "./sample/lib/consumer.ts";')],
    ["plugins/sample/lib/consumer.ts", Buffer.from('import "../../../outside.ts";')],
    ["outside.ts", Buffer.from("export {};")],
  ]);
  assert.throws(() => validate!(escapingFiles, [...escapingFiles.keys()]), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_PLUGIN_DEPENDENCY_MISSING");
    return true;
  });
});

test("Azure DevOps release package keeps source, artifact, integrity, and marketplace assets consistent", async () => {
  const sourceManifest = JSON.parse(await readFile(fileURLToPath(new URL("../extension-packages/azure-devops-platform/extension.json", import.meta.url)), "utf8")) as Record<string, any>;
  const archive = await readFile(fileURLToPath(new URL("../extension-packages/azure-devops-platform.aicxt", import.meta.url)));
  const opencodeDockerfile = await readFile(fileURLToPath(new URL("../../opencode-server/Dockerfile", import.meta.url)), "utf8");
  const packageData = validateAicxtPackage(archive);
  const pluginResource = packageData.resources.find((resource) => resource.kind === "plugins");
  assert.ok(pluginResource);
  validatePluginRelativeDependencies(packageData.files, [pluginResource.path, ...(pluginResource.files ?? [])]);
  const pluginSkillPath = "plugins/azure-devops-platform/skills/minimal-api-service-cloud-run-pipeline/SKILL.md";

  assert.equal(sourceManifest.extensionId, "azure-devops-platform");
  assert.equal(sourceManifest.version, "2.0.2");
  assert.equal(sourceManifest.scope, "project");
  assert.doesNotMatch(opencodeDockerfile, /@azure-devops\/mcp|azure-devops-mcp-bridge/);
  assert.equal(packageData.archiveSha256, createHash("sha256").update(archive).digest("hex"));
  assert.deepEqual(packageData.manifest, sourceManifest);
  assert.equal(sourceManifest.resources.plugins[0].path, "plugins/azure-devops-platform.ts");
  assert.equal(sourceManifest.resources.plugins[0].files.includes("plugins/azure-devops-platform/tools/work-item-details.ts"), true);
  assert.equal(sourceManifest.resources.plugins[0].files.includes("plugins/azure-devops-platform/tools/pull-request-list.ts"), true);
  assert.equal(sourceManifest.resources.plugins[0].files.includes("plugins/azure-devops-platform/tools/work-item-revisions.ts"), true);
  assert.equal(sourceManifest.resources.mcp, undefined);
  assert.deepEqual(sourceManifest.retiredResources, [{
    kind: "mcp",
    name: "azure-devops",
    contextMigration: {
      contextEnvironment: "ado_mcp_context",
      organizationCommandIndex: 2,
      projectEnvironment: "ado_mcp_project",
      settingsKey: "azureDevOps",
    },
  }]);
  assert.equal(matchesSha256Integrity(
    packageData.files.get(sourceManifest.resources.plugins[0].path)!,
    sourceManifest.resources.plugins[0].integrity,
  ), true);
  assert.equal(sourceManifest.resources.skills, undefined);
  assert.equal(sourceManifest.resources.plugins[0].files.includes(pluginSkillPath), true);
  assert.equal(packageData.resources.some((resource) => resource.kind === "skills"), false);
  assert.ok(packageData.files.get(pluginSkillPath));
  assert.equal(packageData.files.has("skills/minimal-api-service-cloud-run-pipeline/SKILL.md"), false);
  const pipelineSkill = packageData.files.get(pluginSkillPath)?.toString("utf8") ?? "";
  assert.match(pipelineSkill, /azure_devops_create_repository/);
  assert.match(pipelineSkill, /azure_devops_configure_remote/);
  assert.match(pipelineSkill, /repository\/<name>/);
  assert.match(pipelineSkill, /repositoryPath/);
  assert.match(pipelineSkill, /azure_devops_push/);
  assert.match(pipelineSkill, /azure_devops_git_pull/);
  assert.match(pipelineSkill, /不要省略巢狀 Repository 的 `repositoryPath`/);
  assert.deepEqual(sourceManifest.pluginContributions, [{
    pluginName: "azure-devops-platform",
    contributions: [
      { kind: "tool", name: "azure_devops_create_repository" },
      { kind: "tool", name: "azure_devops_git_config" },
      { kind: "tool", name: "azure_devops_configure_remote" },
      { kind: "tool", name: "azure_devops_git_pull" },
      { kind: "tool", name: "azure_devops_push" },
      { kind: "tool", name: "azure_devops_clone_repository" },
      { kind: "tool", name: "azure_devops_list_repositories" },
      { kind: "tool", name: "azure_devops_list_pipelines" },
      { kind: "tool", name: "azure_devops_create_pipeline" },
      { kind: "tool", name: "azure_devops_preview_pipeline" },
      { kind: "tool", name: "azure_devops_run_pipeline" },
      { kind: "tool", name: "azure_devops_get_pipeline_run" },
      { kind: "tool", name: "azure_devops_list_wikis" },
      { kind: "tool", name: "azure_devops_write_wiki_page" },
      { kind: "tool", name: "azure_devops_create_work_item" },
      { kind: "tool", name: "azure_devops_get_work_item" },
      { kind: "tool", name: "azure_devops_list_work_item_revisions" },
      { kind: "tool", name: "azure_devops_update_work_item" },
      { kind: "tool", name: "azure_devops_create_pull_request" },
      { kind: "tool", name: "azure_devops_get_pull_request" },
      { kind: "tool", name: "azure_devops_list_pull_requests" },
      { kind: "tool", name: "azure_devops_publish_pipeline_yaml" },
      { kind: "skill", name: "minimal-api-service-cloud-run-pipeline" },
    ],
  }]);
  assert.deepEqual(sourceManifest.workflowNodes, [
    { type: "resource.plugin", name: "azure-devops-platform" },
  ]);

  assert.equal(packageData.manifest.extensionId, "azure-devops-platform");
  assert.equal(packageData.resources.some((resource) => resource.kind === "plugins" && resource.name === "azure-devops-platform"), true);
  assert.equal(packageData.resources.some((resource) => resource.kind === "mcp"), false);
  assert.equal(packageData.files.has("mcp/azure-devops.json"), false);
  assert.equal(packageData.resources.filter((resource) => resource.kind === "skills").length, 0);
  assert.equal(packageData.files.get("extension.json")?.toString("utf8"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  const configuration = JSON.parse(packageData.files.get("config/extension.json")?.toString("utf8") ?? "{}") as Record<string, any>;
  assert.equal(configuration.resources, undefined);
  assert.equal(configuration.mcp, undefined);
  const plugin = packageData.files.get("plugins/azure-devops-platform.ts")?.toString("utf8") ?? "";
  assert.match(plugin, /export/);
  const pluginEntry = packageData.files.get("plugins/azure-devops-platform/azure-devops-platform.ts")?.toString("utf8") ?? "";
  assert.match(pluginEntry, /from "\.\/tools\/repository\.ts"/);
  assert.match(pluginEntry, /from "\.\/tools\/work-item\.ts"/);
  assert.match(pluginEntry, /azure_devops_update_work_item/);
  assert.match(pluginEntry, /azure_devops_get_work_item/);
  assert.match(pluginEntry, /azure_devops_list_work_item_revisions/);
  assert.match(pluginEntry, /expectedRev/);
  assert.match(pluginEntry, /never automatically retry or replay the patch/);
  assert.match(pluginEntry, /get-work-item/);
  assert.match(pluginEntry, /work-item-details\.ts/);
  assert.match(pluginEntry, /work-item-revisions\.ts/);
  assert.match(pluginEntry, /update-work-item/);
  assert.match(pluginEntry, /from "\.\/tools\/pull-request\.ts"/);
  assert.match(pluginEntry, /from "\.\/tools\/pull-request-get\.ts"/);
  assert.match(pluginEntry, /azure_devops_get_pull_request/);
  assert.match(pluginEntry, /get-pull-request/);
  assert.match(pluginEntry, /from "\.\/tools\/pull-request-list\.ts"/);
  assert.match(pluginEntry, /from "\.\/tools\/pipeline-yaml\.ts"/);
  assert.match(pluginEntry, /parentId/);
  const pluginParameters = packageData.files.get("plugins/azure-devops-platform/tools/parameters.ts")?.toString("utf8") ?? "";
  const pluginAgentParameters = packageData.files.get("plugins/azure-devops-platform/agent/parameters.ts")?.toString("utf8") ?? "";
  assert.match(pluginParameters, /updateWorkItem:/);
  assert.match(pluginParameters, /getWorkItem:/);
  assert.match(pluginParameters, /getPullRequest:/);
  assert.match(pluginParameters, /pullRequestId: numberSchema\(\{ integer: true, minimum: 1, maximum: 2_147_483_647/);
  assert.match(pluginParameters, /commitTop: numberSchema\(\{ integer: true, minimum: 1, maximum: 100/);
  assert.match(pluginParameters, /commitContinuationToken: stringSchema\(\{ minLength: 1, maxLength: 2_000/);
  assert.match(pluginParameters, /listWorkItemRevisions:/);
  assert.match(pluginParameters, /const expectedRev = numberSchema\(\{ integer: true, minimum: 1, maximum: 2_147_483_647/);
  assert.match(pluginParameters, /maximum: 20/);
  assert.match(pluginParameters, /minimum: 0, maximum: 2_147_483_647/);
  assert.match(pluginParameters, /workItemId: numberSchema\(\{ integer: true, minimum: 1/);
  assert.match(pluginAgentParameters, /azure_devops_update_work_item/);
  assert.match(pluginAgentParameters, /azure_devops_get_work_item/);
  assert.match(pluginAgentParameters, /azure_devops_list_work_item_revisions/);
  assert.match(pluginAgentParameters, /"expectedRev"/);
  assert.match(pluginParameters, /parentId: numberSchema\(\{ integer: true, minimum: 1/);
  assert.match(pluginParameters, /maximum: 2_147_483_647/);
  assert.match(pluginParameters, /PIPELINE_YAML_PATH_PATTERN/);
  assert.match(pluginParameters, /maxLength: 100_000/);
  for (const listField of ["reviewerIds", "workItemIds", "labels"]) assert.match(pluginParameters, new RegExp(`${listField}`));
  assert.match(pluginParameters, /maxItems: 50/);
  for (const listField of ["reviewerIds", "workItemIds", "labels"]) assert.match(pluginAgentParameters, new RegExp(`"${listField}"`));
  assert.match(pluginEntry, /from "\.\/tools\/repository-path\.ts"/);
  assert.match(pluginEntry, /from "\.\/tools\/repository-list\.ts"/);
  assert.match(pluginEntry, /from "\.\/tools\/pipeline\.ts"/);
  assert.match(pluginEntry, /readAzureDevOpsPipelinePreviewResponse/);
  assert.match(pluginEntry, /readAzureDevOpsPipelineRunResponse/);
  assert.match(pluginEntry, /readAzureDevOpsPipelineRunStatusResponse/);
  assert.match(pluginEntry, /from "\.\/tools\/pull\.ts"/);
  assert.match(pluginEntry, /resolveAzureDevOpsPushRepositoryPath/);
  assert.match(pluginEntry, /nested checkout under repository\/<name>/);
  assert.match(pluginEntry, /repositoryPath/);
  assert.match(pluginEntry, /matching repository\/<repositoryName> checkout is selected automatically/);
  assert.match(pluginEntry, /UI-configured organization and project/);
  assert.match(pluginEntry, /content: JSON\.stringify\(value, null, 2\)/);
  assert.match(pluginParameters, /continuationToken: stringSchema\(\{ minLength: 1, maxLength: 2_000/);
  assert.match(pluginParameters, /yamlPath: stringSchema\(\{ minLength: 1, maxLength: 1_024/);
  assert.match(pluginParameters, /pipelineId: pipelineID/);
  assert.match(pluginParameters, /templateParameters/);
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/pipeline.ts"));
  for (const field of ["reproSteps", "systemInfo", "severity", "acceptanceCriteria"]) {
    assert.match(pluginParameters, new RegExp(field));
  }
  for (const toolName of [
    "azure_devops_create_repository",
    "azure_devops_git_config",
    "azure_devops_configure_remote",
    "azure_devops_git_pull",
    "azure_devops_push",
    "azure_devops_clone_repository",
    "azure_devops_list_repositories",
    "azure_devops_list_pipelines",
    "azure_devops_create_pipeline",
    "azure_devops_preview_pipeline",
    "azure_devops_run_pipeline",
    "azure_devops_get_pipeline_run",
    "azure_devops_list_wikis",
    "azure_devops_write_wiki_page",
    "azure_devops_create_work_item",
    "azure_devops_get_work_item",
    "azure_devops_list_work_item_revisions",
    "azure_devops_create_pull_request",
    "azure_devops_get_pull_request",
    "azure_devops_list_pull_requests",
    "azure_devops_publish_pipeline_yaml",
  ]) assert.match(pluginEntry, new RegExp(toolName));
  assert.match(pluginEntry, /from "\.\/tools\/wiki\.ts"/);
  for (const path of sourceManifest.resources.plugins[0].files) {
    assert.ok(packageData.files.get(path), `${path} must be packaged as a Plugin companion file`);
  }
  const frontend = packageData.files.get("frontend/entry.js")?.toString("utf8") ?? "";
  assert.match(frontend, /version: "1\.6\.46"/);
  assert.match(frontend, /readExtensionSettings/);
  assert.match(frontend, /writeExtensionSettings/);
  assert.match(frontend, /data-policy-tools/);
  assert.match(frontend, /assertRequiredPipelinePolicy/);
  assert.match(frontend, /azure_devops_preview_pipeline/);
  assert.match(frontend, /azure_devops_run_pipeline/);
  assert.match(frontend, /azure_devops_get_pipeline_run/);
  assert.match(frontend, /assertRequiredPullRequestPolicy/);
  assert.match(frontend, /assertRequiredPullRequestDetailsPolicy/);
  assert.match(frontend, /assertPullRequestListPolicy/);
  assert.match(frontend, /azure-devops-pull-request-status/);
  assert.match(frontend, /assertRequiredWorkItemUpdatePolicy/);
  assert.match(frontend, /assertRequiredWorkItemGetPolicy/);
  assert.match(frontend, /assertRequiredWorkItemRevisionsPolicy/);
  assert.match(frontend, /name: "expectedRev", label: "Expected revision \(call-time only\)"/);
  assert.match(frontend, /not stored as a fixed Project value/);
  assert.match(frontend, /azure_devops_get_work_item/);
  assert.match(frontend, /azure_devops_list_work_item_revisions/);
  assert.match(frontend, /type: "json-array"/);
  assert.match(frontend, /parsePolicyArrayText/);
  assert.match(frontend, /azure-devops-branch-ref/);
  assert.match(frontend, /isRepositoryYamlPolicyPath/);
  assert.match(frontend, /data-create-project-wiki/);
  assert.match(frontend, /create-project-wiki/);
  assert.match(frontend, /requiredAlways: true/);
  assert.match(frontend, /Parent Work Item ID/);
  assert.match(frontend, /fixed 模式須傳入 UI 指定的相同路徑/);
  for (const toolName of [
    "azure_devops_create_repository",
    "azure_devops_configure_remote",
    "azure_devops_git_pull",
    "azure_devops_push",
    "azure_devops_clone_repository",
    "azure_devops_list_repositories",
    "azure_devops_list_pipelines",
    "azure_devops_create_pipeline",
    "azure_devops_preview_pipeline",
    "azure_devops_run_pipeline",
    "azure_devops_get_pipeline_run",
    "azure_devops_list_wikis",
    "azure_devops_write_wiki_page",
    "azure_devops_create_work_item",
    "azure_devops_get_work_item",
    "azure_devops_list_work_item_revisions",
    "azure_devops_update_work_item",
    "azure_devops_create_pull_request",
    "azure_devops_get_pull_request",
    "azure_devops_list_pull_requests",
    "azure_devops_publish_pipeline_yaml",
  ]) assert.match(frontend, new RegExp(toolName));
  assert.match(frontend, /Repository-relative YAML path/);
  assert.match(frontend, /Complete YAML content/);
  assert.match(frontend, /Description、Repro Steps、System Info 與 Acceptance Criteria 會以原始 Markdown 保存/);
  assert.match(frontend, /不能再改回 HTML/);
  assert.match(frontend, /Tags 使用分號分隔/);
  assert.match(frontend, /name: "priority", label: "Priority", type: "integer"/);
  assert.match(frontend, /const numeric = numericPolicy\(fieldDefinition\)/);
  assert.match(frontend, /input\.step = numeric\.step/);
  assert.match(frontend, /function numericPolicy\(field\)/);
  for (const field of ["areaPath", "iterationPath", "assignedTo", "priority", "tags", "state"]) {
    assert.match(frontend, new RegExp(`name: "${field}"`));
  }
  for (const field of ["reproSteps", "systemInfo", "severity", "acceptanceCriteria"]) {
    assert.match(frontend, new RegExp(`name: "${field}"`));
  }
  assert.match(frontend, /multiline: true/);
  for (const field of ["originalEstimate", "remainingWork", "completedWork", "activity", "storyPoints", "effort", "size", "businessValue"]) {
    assert.match(frontend, new RegExp(`name: "${field}"`));
  }
  assert.match(frontend, /step: integer \? "1" : "any"/);
  assert.match(frontend, /Number\.isFinite\(value\)/);
  assert.match(frontend, /read-only derived|唯讀 derived/);
  assert.match(frontend, /max-width:720px/);
  const extensionBackend = packageData.files.get("backend/entry.js")?.toString("utf8") ?? "";
  assert.match(extensionBackend, /"publish-pipeline-yaml": publishPipelineYaml/);
  assert.match(extensionBackend, /oldObjectId: branchTip/);
  assert.match(extensionBackend, /ADO_PIPELINE_YAML_PATH_CONFLICT/);
  assert.match(extensionBackend, /ADO_PIPELINE_YAML_BRANCH_CONFLICT/);
  assert.match(extensionBackend, /"create-work-item": createWorkItem/);
  assert.match(extensionBackend, /"get-work-item": getWorkItem/);
  assert.match(extensionBackend, /"list-work-item-revisions": listWorkItemRevisions/);
  assert.match(extensionBackend, /WORK_ITEM_REVISION_TOP_MAX = 20/);
  assert.match(extensionBackend, /truncatedFields/);
  assert.match(extensionBackend, /WORK_ITEM_READ_FIELD_REFERENCES/);
  assert.match(extensionBackend, /System\.WorkItemType/);
  assert.match(extensionBackend, /System\.ChangedBy/);
  assert.match(extensionBackend, /"update-work-item": updateWorkItem/);
  assert.match(extensionBackend, /path: "\/rev", value: expectedRev/);
  assert.match(extensionBackend, /ADO_WORK_ITEM_REVISION_CONFLICT/);
  assert.match(extensionBackend, /"create-pull-request": createPullRequest/);
  assert.match(extensionBackend, /"get-pull-request": getPullRequest/);
  assert.match(extensionBackend, /ADO_PULL_REQUEST_NOT_FOUND/);
  assert.match(extensionBackend, /PULL_REQUEST_COMMIT_TOP_DEFAULT = 50/);
  assert.match(extensionBackend, /PULL_REQUEST_COMMIT_TOP_MAX = 100/);
  assert.match(extensionBackend, /lastMergeSourceCommit/);
  assert.match(extensionBackend, /lastMergeTargetCommit/);
  assert.match(extensionBackend, /lastMergeCommit/);
  assert.match(extensionBackend, /"list-pull-requests": listPullRequests/);
  assert.match(extensionBackend, /_apis\/git\/repositories\/\$\{encodeURIComponent\(repository\.id\)\}\/pullrequests/);
  assert.match(extensionBackend, /supportsIterations/);
  assert.match(extensionBackend, /reviewerIds\.map\(\(id\) => \(\{ id \}\)\)/);
  assert.match(extensionBackend, /workItemIds\.map\(\(id\) => \(\{ id: String\(id\) \}\)\)/);
  assert.match(extensionBackend, /labels\.map\(\(name\) => \(\{ name \}\)\)/);
  assert.match(extensionBackend, /ADO_PULL_REQUEST_CREATE_OUTCOME_UNKNOWN/);
  assert.match(extensionBackend, /"list-pipelines": listPipelines/);
  assert.match(extensionBackend, /"create-pipeline": createPipeline/);
  assert.match(extensionBackend, /"preview-pipeline": previewPipeline/);
  assert.match(extensionBackend, /"run-pipeline": runPipeline/);
  assert.match(extensionBackend, /"get-pipeline-run": getPipelineRun/);
  assert.match(extensionBackend, /"list-repositories": listRepositories/);
  assert.match(extensionBackend, /_apis\/pipelines\?api-version=7\.1/);
  assert.match(extensionBackend, /versionDescriptor\.versionType/);
  assert.match(extensionBackend, /defaultBranch/);
  assert.match(extensionBackend, /_apis\/git\/repositories\?api-version=7\.1/);
  assert.match(extensionBackend, /application\/json-patch\+json/);
  assert.match(extensionBackend, /referenceName: "System\.Description", validation: "markdown", markdown: true/);
  assert.match(extensionBackend, /System\.LinkTypes\.Hierarchy-Reverse/);
  for (const referenceName of ["System.AreaPath", "System.IterationPath", "System.AssignedTo", "Microsoft.VSTS.Common.Priority", "System.Tags", "System.State"]) {
    assert.match(extensionBackend, new RegExp(referenceName.replaceAll(".", "\\.")));
  }
  assert.match(extensionBackend, /Microsoft\.VSTS\.TCM\.ReproSteps/);
  assert.match(extensionBackend, /Microsoft\.VSTS\.TCM\.SystemInfo/);
  assert.match(extensionBackend, /Microsoft\.VSTS\.Common\.Severity/);
  assert.match(extensionBackend, /Microsoft\.VSTS\.Common\.AcceptanceCriteria/);
  assert.match(extensionBackend, /multilineFieldsFormat\/\$\{field\.referenceName\}/);
  for (const reference of [
    "Microsoft.VSTS.Scheduling.OriginalEstimate",
    "Microsoft.VSTS.Scheduling.RemainingWork",
    "Microsoft.VSTS.Scheduling.CompletedWork",
    "Microsoft.VSTS.Common.Activity",
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Scheduling.Effort",
    "Microsoft.VSTS.Scheduling.Size",
    "Microsoft.VSTS.Common.BusinessValue",
  ]) assert.ok(extensionBackend.includes(reference), `${reference} mapping must be packaged`);
  assert.match(extensionBackend, /Number\.isFinite\(value\)/);
  assert.match(extensionBackend, /"create-project-wiki": createProjectWiki/);
  assert.match(extensionBackend, /type: "projectWiki"/);
  assert.match(extensionBackend, /GitRepositoryNameAlreadyExistsException/);
  assert.match(extensionBackend, /recoveredExistingRepository/);
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/repository-list.ts"));
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/pipeline-yaml.ts"));
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/pipeline.ts"));
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/pull-request.ts"));
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/pull-request-get.ts"));
  assert.ok(packageData.files.get("plugins/azure-devops-platform/tools/work-item-revisions.ts"));

  for (const [manifestKey, assetPath] of [
    ["frontend", "frontend/entry.js"],
    ["backend", "backend/entry.js"],
    ["configuration", "config/extension.json"],
  ] as const) {
    const asset = sourceManifest[manifestKey];
    const content = packageData.files.get(assetPath);
    assert.ok(content, `${assetPath} must be packaged`);
    assert.equal(matchesSha256Integrity(content, asset.integrity[assetPath]), true, `${assetPath} integrity must match`);
  }
});

test("rejects the project-scoped Azure DevOps package at the global install boundary", async () => {
  const archive = await readFile(fileURLToPath(new URL("../extension-packages/azure-devops-platform.aicxt", import.meta.url)));
  const service = new PlatformExtensionService({} as never, {} as never, {} as never);

  await assert.rejects(
    () => service.installPackage({
      archive,
      extend: false,
      filename: "azure-devops-platform.aicxt",
      scope: "global",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_PACKAGE_SCOPE_UNSUPPORTED");
      assert.deepEqual((error as { details?: unknown }).details, {
        extensionId: "azure-devops-platform",
        packageScope: "project",
        requestedScope: "global",
      });
      return true;
    },
  );
});

test("passes project plugin config with the resource bundle to workflow-test synchronization", async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "azure-devops-extension-install-"));
  try {
    const archive = await readFile(fileURLToPath(new URL("../extension-packages/azure-devops-platform.aicxt", import.meta.url)));
    const config = loadConfig({
      ...process.env,
      EXTENSION_PACKAGE_ROOT: join(root, "packages"),
      OPENCODE_DATA_ROOT: join(root, "data"),
      OPENCODE_PROJECTS_ROOT: join(root, "projects"),
      OPENCODE_GLOBAL_REGISTRY_ROOT: join(root, "global", ".opencode"),
      WORKFLOW_DATA_ROOT: join(root, "workflow-data"),
    });
    const applied: Array<Record<string, unknown>> = [];
    const registryUpserts: Array<{ body: Record<string, unknown>; kind: string; name: string }> = [];
    const registry = {
      delete: async () => undefined,
      list: async () => ({ entries: [] }),
      read: async () => { throw new HttpError(404, "missing", "OPENCODE_REGISTRY_NOT_FOUND"); },
      upsert: async (_scope: string, kind: string, name: string, body: Record<string, unknown>) => {
        registryUpserts.push({ body, kind, name });
        return { root: "", files: [] };
      },
    };
    const projectConfig = {
      apply: async (_scope: string, _project: string | undefined, body: Record<string, unknown>) => { applied.push(body); return {} as never; },
      restore: async () => undefined,
      snapshot: async () => ({ scope: "project" as const, project: "demo", path: "", exists: false, config: {}, content: "{}" }),
    };
    const syncInputs: Array<Record<string, unknown>> = [];
    const workflows = {
      syncWorkflowTestResources: async (input: Record<string, unknown>) => {
        syncInputs.push(input);
        return {
          mcp: { removed: [], upserted: [] },
          plugins: { synchronized: true, projectPlugins: ["./.opencode/plugins/azure-devops-platform.ts"] },
          project: "demo",
          registry: { removed: [], upserted: ["azure-devops-platform"] },
          restart: { requested: false },
          rollback: async () => undefined,
          scope: "project" as const,
          target: "workflow-test" as const,
        };
      },
    };
    const service = new PlatformExtensionService(config, registry as never, projectConfig as never, workflows as never);
    const result = await service.installPackage({
      archive,
      extend: false,
      filename: "azure-devops-platform.aicxt",
      project: "demo",
      scope: "project",
    });

    const sync = syncInputs[0];
    assert.deepEqual(sync?.removeMcpNames, []);
    assert.deepEqual(sync?.mcp, undefined);
    assert.deepEqual((sync?.pluginConfig as { projectPlugins: string[] }).projectPlugins, ["./.opencode/plugins/azure-devops-platform.ts"]);
    assert.equal((sync?.registryResources as Array<{ kind: string; name: string }>).some((resource) => resource.kind === "plugins" && resource.name === "azure-devops-platform"), true);
    assert.equal(applied.some((body) => Array.isArray((body.config as Record<string, unknown> | undefined)?.plugin)), true);
    const pluginUpsert = registryUpserts.find((entry) => entry.kind === "plugins" && entry.name === "azure-devops-platform");
    const pluginFiles = pluginUpsert?.body.files as Record<string, string> | undefined;
    assert.ok(pluginFiles);
    assert.ok(pluginFiles["azure-devops-platform.ts"]);
    assert.ok(pluginFiles["azure-devops-platform/tools/repository.ts"]);
    assert.ok(pluginFiles["azure-devops-platform/tools/work-item.ts"]);
    assert.ok(pluginFiles["azure-devops-platform/backend-client/client.ts"]);
    assert.ok(pluginFiles["azure-devops-platform/skills/minimal-api-service-cloud-run-pipeline/SKILL.md"]);
    assert.equal(registryUpserts.some((entry) => entry.kind === "skills"), false);
    assert.equal(result.manifest.resources.some((resource) => resource.kind === "skills"), false);
    assert.equal(result.manifest.scope, "project");

    const settings = { azureDevOps: { organization: "contoso", project: "ado-project" } };
    await service.writeSettings("azure-devops-platform", "project", "demo", settings);
    assert.deepEqual(await service.readSettings("azure-devops-platform", "project", "demo"), settings);
    await assert.rejects(
      () => service.writeSettings("azure-devops-platform", "project", "demo", { azureDevOps: { token: "pat-plaintext" } }),
      { code: "AZURE_DEVOPS_PLAINTEXT_SECRET" },
    );
    await service.installPackage({
      archive,
      extend: true,
      filename: "azure-devops-platform.aicxt",
      project: "demo",
      scope: "project",
    });
    assert.deepEqual(await service.readSettings("azure-devops-platform", "project", "demo"), settings);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
