import assert from "node:assert/strict";
import test from "node:test";
import { buildExtensionPackage } from "../../../scripts/build-extension-packages.js";

test("發布 backend 自包含政策 hooks，解析 Project 並拒絕秘密設定", async () => {
  const { files } = await buildExtensionPackage("azure-devops-platform");
  const module = await import(`data:text/javascript;base64,${files.get("backend/entry.js").toString("base64")}`);
  assert.equal(typeof module.activate, "function");
  assert.equal(typeof module.prepareRequest, "function");
  const settings = module.normalizeSettings({ azureDevOps: { organization: "contoso", project: "ado-project" } });
  const context = module.runtimeContext(settings, "managed-project");
  assert.equal(context.azureDevOpsContext.openCodeProject, "managed-project");
  assert.equal(context.azureDevOpsContext.adoProject, "ado-project");
  assert.throws(() => module.normalizeSettings({ azureDevOps: { token: "secret-token" } }), { code: "AZURE_DEVOPS_PLAINTEXT_SECRET" });
  assert.throws(() => module.prepareRequest({
    path: "list-repositories", body: { tool: "azure_devops_push" },
  }, { project: "managed-project", settings }), { code: "AZURE_DEVOPS_TOOL_PATH_MISMATCH" });
  const request = module.prepareRequest({
    path: "list-repositories", body: { tool: "azure_devops_list_repositories", agentInput: {} },
    extensionContext: { azureDevOps: { effectiveContext: { openCodeProject: "attacker" } } },
  }, { project: "managed-project", settings });
  assert.equal(request.extensionContext.azureDevOps.effectiveContext.openCodeProject, "managed-project");
  assert.equal(request.extensionContext.azureDevOps.resolvedToolCall.tool, "azure_devops_list_repositories");
});

test("Azure CLI 手動安裝入口與固定版本隨套件發布，啟動不會呼叫安裝器", async () => {
  const { files } = await buildExtensionPackage("azure-devops-platform");
  assert.match(files.get("runtime/azure-cli-versions.env").toString(), /AZURE_CLI_VERSION=2\.93\.0/);
  assert.match(files.get("runtime/azure-cli-versions.env").toString(), /AZURE_DEVOPS_EXTENSION_VERSION=1\.0\.11/);
  const installer = files.get("runtime/install-azure-cli-runtime.sh").toString();
  assert.match(installer, /packages\.microsoft\.com\/repos\/azure-cli/);
  assert.match(installer, /az extension add --name azure-devops --version/);
  assert.doesNotMatch(files.get("backend/entry.js").toString(), /install-azure-cli-runtime\.sh/);
});
