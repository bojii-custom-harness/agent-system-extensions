import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../source/", import.meta.url);

test("Azure DevOps Extension 提供 shell 設定介面，不再發布 Agent tools", async () => {
  const manifest = JSON.parse(await readFile(new URL("extension.json", source), "utf8"));
  assert.equal(manifest.version, "4.0.0");
  assert.equal(manifest.backend.entry, "backend/cli-entry.js");
  assert.equal(manifest.frontend.entry, "frontend/cli-entry.js");
  assert.equal(manifest.pluginContributions, undefined);
  assert.equal(manifest.resources, undefined);
  assert.equal(manifest.workflowNodes, undefined);
  assert.equal(manifest.metadata.retirePreviousPluginContributions, true);
});

test("SSO 仍由可信 Project context 決定，舊 run-cli 入口退役", async () => {
  const { activate, prepareRequest } = await import(new URL("backend/cli-entry.js", source));
  const prepared = prepareRequest({ method: "POST", path: "status" }, {
    project: "trusted-project",
    settings: { azureDevOps: { organization: "ExampleOrg", project: "Team Project", token: "legacy data is retained" } },
  });
  assert.deepEqual(prepared.trustedContext, {
    agentSystemProject: "trusted-project",
    organization: "ExampleOrg",
    adoProject: "Team Project",
  });
  assert.equal(prepared.trustedContext.token, undefined);
  const runtime = await activate({}, { docker: () => { throw new Error("不可執行任意命令"); } });
  await assert.rejects(runtime.handle({ host: {}, request: { ...prepared, path: "run-cli", body: { arguments: ["project", "list"] } } }), { code: "ADO_PATH_NOT_FOUND" });
});

test("Azure DevOps UI keeps Organization and Project settings without PAT configuration", async () => {
  const ui = await readFile(new URL("frontend/cli-entry.js", source), "utf8");
  assert.match(ui, /readExtensionSettings/);
  assert.match(ui, /writeExtensionSettings/);
  assert.match(ui, /data-organization/);
  assert.match(ui, /data-project/);
  assert.match(ui, /Microsoft Entra SSO/);
  assert.doesNotMatch(ui, /data-pat|Personal Access Token|store-credential|verify-token/);
});

test("Azure DevOps CLI runtime pins the official CLI and extension versions", async () => {
  const versions = await readFile(new URL("../runtime/azure-cli-versions.env", import.meta.url), "utf8");
  const installer = await readFile(new URL("../runtime/install-azure-cli-runtime.sh", import.meta.url), "utf8");
  assert.match(versions, /^AZURE_CLI_VERSION=2\.93\.0$/m);
  assert.match(versions, /^AZURE_DEVOPS_EXTENSION_VERSION=1\.0\.11$/m);
  assert.match(installer, /az extension add --name azure-devops --version "\$AZURE_DEVOPS_EXTENSION_VERSION"/);
});
