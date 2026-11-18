import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../source/", import.meta.url);

test("Azure DevOps Extension exposes only the CLI tool and ships its entry points", async () => {
  const manifest = JSON.parse(await readFile(new URL("extension.json", source), "utf8"));
  assert.equal(manifest.version, "3.0.0");
  assert.equal(manifest.backend.entry, "backend/cli-entry.js");
  assert.equal(manifest.frontend.entry, "frontend/cli-entry.js");
  assert.deepEqual(manifest.pluginContributions[0].contributions, [{ kind: "tool", name: "azure_devops_cli" }]);
  assert.ok(!manifest.workflowNodes.some(({ type }) => type === "resource.skill"));
  assert.ok(manifest.resources.plugins[0].files.every((path) => !/clone|pull|push|repository|workitem|pipeline/i.test(path)));
});

test("Azure DevOps CLI arguments are bounded and cannot override selected context", async () => {
  const { validateArguments, prepareRequest } = await import(new URL("backend/cli-entry.js", source));
  assert.deepEqual(validateArguments(["project", "list"]), ["project", "list"]);
  assert.throws(() => validateArguments(["project", "list", "--org", "other"]), (error) => error.code === "ADO_CLI_CONTEXT_OVERRIDE_DENIED");
  assert.throws(() => validateArguments(["--project=other"]), (error) => error.code === "ADO_CLI_CONTEXT_OVERRIDE_DENIED");
  assert.deepEqual(validateArguments(["invoke", "--http-method", "GET"]), ["invoke", "--http-method", "GET"]);
  assert.throws(() => validateArguments([]), (error) => error.code === "ADO_CLI_ARGUMENTS_INVALID");
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
