import assert from "node:assert/strict";
import test from "node:test";
import { buildExtensionPackage } from "../../../scripts/build-extension-packages.js";
import { activate, prepareRequest, decodeDockerStream, resolveOrganizationTenant } from "../source/backend/cli-entry.js";

test("發布的 backend 與 frontend 符合宿主載入契約，保留設定並覆蓋偽造 context", async () => {
  const { files, manifest } = await buildExtensionPackage("azure-devops-platform");
  const backend = await import(`data:text/javascript;base64,${files.get(manifest.backend.entry).toString("base64")}`);
  const frontend = await import(`data:text/javascript;base64,${files.get(manifest.frontend.entry).toString("base64")}`);
  assert.equal(typeof (await frontend.activate({})).editor.mount, "function");
  const settings = { azureDevOps: { organization: "contoso", project: "ado-project", legacy: "保留" } };
  assert.deepEqual(backend.normalizeSettings(settings), settings);
  const request = backend.prepareRequest({ trustedContext: { agentSystemProject: "attacker" } }, { project: "managed-project", settings });
  assert.equal(request.trustedContext.agentSystemProject, "managed-project");
  assert.equal(request.trustedContext.adoProject, "ado-project");
  assert.equal(typeof (await backend.activate()).handle, "function");
  assert.equal(manifest.metadata.retirePreviousPluginContributions, true);
  assert.equal(files.has("backend/entry.js"), false);
});

function frame(text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test("Docker 日誌保持繁體中文與多 frame 的 UTF-8 位元組", () => {
  assert.equal(decodeDockerStream(Buffer.concat([frame("專案"), frame("✓")])), "專案✓");
});

test("configure 經實際 handler 將前端預設寫至共用 profile，使用原 volume subpath 並清理容器", async () => {
  const calls = [];
  const id = "a".repeat(64);
  const docker = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.includes("agent-system-opencode-server/json")) return { body: {
      State: { Running: true },
      Config: { Labels: { "com.docker.compose.service": "opencode-server" } },
      Mounts: [{ Destination: "/var/lib/agent-system/extensions", Type: "volume", Name: "test-data" }],
      HostConfig: { Mounts: [{ Target: "/var/lib/agent-system/extensions", VolumeOptions: { Subpath: "extensions" } }] },
    } };
    if (path.startsWith("/containers/create")) return { status: 201, body: { Id: id } };
    if (path.endsWith("/start")) return { status: 204 };
    if (path.endsWith("/json")) return { body: { State: { Running: false, ExitCode: 0 } } };
    if (path.includes("/logs?")) return { bytes: frame('{"name":"專案"}') };
    if (method === "DELETE") return { status: 204 };
    throw new Error(`未預期呼叫 ${method} ${path}`);
  };
  const runtime = await activate({}, { docker });
  const request = prepareRequest({ method: "POST", path: "configure" }, {
    project: "fixture", settings: { azureDevOps: { organization: "contoso", project: "專案" } },
  });
  const result = await runtime.handle({ host: { project: "fixture" }, request });
  assert.equal(result.body.configured, true);
  const payload = calls.find((call) => call.path.startsWith("/containers/create")).body;
  assert.deepEqual(payload.Cmd, ["devops", "configure", "--defaults", "organization=https://dev.azure.com/contoso", "project=專案"]);
  assert.ok(payload.Env.includes("AZURE_DEVOPS_EXT__DEFAULTS_PROJECT=專案"));
  assert.deepEqual(payload.HostConfig.Mounts[0].VolumeOptions, { Subpath: "extensions" });
  assert.equal(calls.at(-1).method, "DELETE");
  await runtime.handle({ host: { project: "fixture" }, request: prepareRequest({ method: "POST", path: "configure" }, {
    project: "fixture", settings: { azureDevOps: { organization: "another-org" } },
  }) });
  const cleared = calls.filter((call) => call.path.startsWith("/containers/create")).at(-1).body;
  assert.equal(cleared.Cmd.at(-1), "project=");
});

test("Organization 租戶只取 Azure DevOps challenge，不跟隨登入重新導向", async () => {
  const tenant = "362cde52-5afc-46de-838e-c4fecfbe4e75";
  const result = await resolveOrganizationTenant("doublecash", async (url, options) => {
    assert.equal(url, "https://dev.azure.com/doublecash/_apis/projects?api-version=7.1");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers["X-TFS-FedAuthRedirect"], "Suppress");
    return new Response(null, { status: 401, headers: { "x-vss-resourcetenant": tenant.toUpperCase() } });
  });
  assert.equal(result, tenant);
  await assert.rejects(resolveOrganizationTenant("doublecash", async () => new Response(null, { status: 401 })), { code: "ADO_TENANT_DISCOVERY_FAILED" });
});

test("已登入其他租戶時回報不符，重新登入必須指定 Organization 租戶", async () => {
  const tenant = "362cde52-5afc-46de-838e-c4fecfbe4e75";
  const wrongTenant = "19f25823-17ff-421f-ad4e-8fed035aedda";
  const created = [];
  const id = "b".repeat(64);
  const docker = async (method, path, body) => {
    if (path.includes("agent-system-opencode-server/json")) return { body: {
      State: { Running: true }, Config: { Labels: { "com.docker.compose.service": "opencode-server" } },
      Mounts: [{ Destination: "/var/lib/agent-system/extensions", Type: "volume", Name: "fixture" }],
    } };
    if (path.startsWith("/containers/json?")) return { body: [] };
    if (path.startsWith("/containers/create")) { created.push(body); return { status: 201, body: { Id: id } }; }
    if (path.endsWith("/start") || method === "DELETE") return { status: 204 };
    if (path.endsWith("/json")) return { body: { State: { Running: false, ExitCode: 0 } } };
    if (path.includes("/logs?")) return { bytes: frame(JSON.stringify(wrongTenant)) };
    throw new Error(`未預期呼叫 ${method} ${path}`);
  };
  const runtime = await activate({}, { docker, browser: async () => ({}), resolveTenant: async () => tenant });
  const call = (path) => runtime.handle({ host: { project: "fixture" }, request: prepareRequest({ method: "POST", path }, {
    project: "fixture", settings: { azureDevOps: { organization: "doublecash" } },
  }) });
  assert.deepEqual((await call("status")).body, { authenticated: false, login: "tenant-mismatch", project: "fixture" });
  const login = (await call("login")).body;
  assert.equal(login.login, "pending");
  const args = created.at(-1).Cmd;
  assert.equal(args[args.indexOf("--tenant") + 1], tenant);
  assert.ok(args.includes("--allow-no-subscriptions"));
  assert.equal(created.at(-1).HostConfig.NetworkMode, "container:agent-system-opencode-server");
});
