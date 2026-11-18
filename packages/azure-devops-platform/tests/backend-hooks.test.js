import assert from "node:assert/strict";
import test from "node:test";
import { buildExtensionPackage } from "../../../scripts/build-extension-packages.js";
import { activate, prepareRequest, decodeDockerStream } from "../source/backend/cli-entry.js";

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

test("invoke 經實際 handler 使用 argv、Project 預設與原 volume subpath，完成後移除容器", async () => {
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
  const request = prepareRequest({ method: "POST", path: "run-cli", body: { arguments: ["invoke", "--area", "core", "-o", "json"] } }, {
    project: "fixture", settings: { azureDevOps: { organization: "contoso", project: "專案" } },
  });
  const result = await runtime.handle({ host: { project: "fixture" }, request });
  assert.equal(result.body.output, '{"name":"專案"}');
  const payload = calls.find((call) => call.path.startsWith("/containers/create")).body;
  assert.deepEqual(payload.Cmd, ["devops", "invoke", "--area", "core", "-o", "json", "--org", "https://dev.azure.com/contoso"]);
  assert.ok(payload.Env.includes("AZURE_DEVOPS_EXT__DEFAULTS_PROJECT=專案"));
  assert.deepEqual(payload.HostConfig.Mounts[0].VolumeOptions, { Subpath: "extensions" });
  assert.equal(calls.at(-1).method, "DELETE");
});
