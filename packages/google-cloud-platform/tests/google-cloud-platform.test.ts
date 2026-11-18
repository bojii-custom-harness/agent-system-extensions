import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readAicxtManifest } from "../../cli/src/zip.js";
import { buildExtensionPackage } from "../../../scripts/build-extension-packages.js";
import { buildBrowserRemoteUrl, createGoogleCloudPlatformBackend, parseAuthorizationCallback } from "../source/backend/entry.js";

const packageRoot = fileURLToPath(new URL("../source/", import.meta.url));
const archivePath = fileURLToPath(new URL("../google-cloud-platform-2.0.3.aicxt", import.meta.url));
const expectedPackageFiles = [
  "backend/entry.js", "config/extension.json", "extension.json", "frontend/entry.js",
  "runtime/README.md", "runtime/gcloud-project-selector.mjs", "runtime/gcloud-wrapper.sh", "runtime/install-gcloud.sh",
];
const runtimeName = "synthetic-main-runtime";
const runtimeExtensionDataRoot = "/var/lib/agent-system/extensions";
const runtimeConfigRoot = `${runtimeExtensionDataRoot}/google-cloud-platform/projects`;
const sharedVolumeName = "synthetic-gcloud-shared-volume";
const syntheticAuthorizationUrl = "https://accounts.google.com/o/oauth2/auth?state=synthetic-state-123&redirect_uri=http%3A%2F%2Flocalhost%3A34001%2F";

test("GCP package archives the main-runtime login UI without the gcloud_cli contribution", async () => {
  const { archive: builtArchive, files, manifest } = await buildExtensionPackage("google-cloud-platform");
  const manifestText = files.get("extension.json")!.toString("utf8");
  const archive = await readFile(archivePath);
  const archivedManifest = readAicxtManifest(archive);
  const buildInfo = JSON.parse(await readFile(new URL("../build-info.json", import.meta.url), "utf8"));
  const archivedFiles = [...files.keys()].sort();

  assert.equal(manifest.version, "2.0.3");
  assert.equal(manifest.scope, "project");
  assert.deepEqual(archivedFiles, expectedPackageFiles);
  assert.deepEqual(archive, builtArchive);
  assert.equal(archivedManifest.extensionId, "google-cloud-platform");
  assert.equal(archivedManifest.version, "2.0.3");
  assert.equal(buildInfo.version, "2.0.3");
  assert.equal(buildInfo.artifact.sha256, createHash("sha256").update(archive).digest("hex"));
  assert.equal(manifest.resources, undefined);
  assert.equal(manifest.pluginContributions, undefined);
  assert.equal(manifest.workflowNodes, undefined);
  assert.equal(manifest.backend.lifecycle.install, "install");

  assert.equal(manifestText, `${JSON.stringify(manifest, null, 2)}\n`);

  for (const path of expectedPackageFiles.filter((path) => path !== "extension.json")) {
    const source = await readFile(`${packageRoot}${path}`);
    assert.deepEqual(files.get(path), source, `${path} in the archive must match its source`);
  }

  const frontend = files.get("frontend/entry.js")!.toString("utf8");
  const backend = files.get("backend/entry.js")!.toString("utf8");
  const configuration = JSON.parse(files.get("config/extension.json")!.toString("utf8")) as Record<string, any>;
  assert.match(frontend, /version: "2\.0\.3"/);
  assert.match(frontend, /main runtime 的 gcloud listener 直接接收/);
  assert.match(frontend, /Project 設定目錄只是預設選擇，不是存取控制/);
  assert.match(frontend, /legacy-cleanup/);
  assert.match(frontend, /window\.confirm/);
  assert.match(backend, /CLOUDSDK_CONFIG=\$\{configPath\}/);
  assert.match(backend, /request\.path === "legacy-cleanup"/);
  assert.doesNotMatch(`${manifestText}\n${frontend}\n${backend}`, /gcloud_cli|pluginContributions|resource\.plugin/);
  assert.deepEqual(configuration.platforms, [{
    id: "google-cloud-platform",
    displayName: "Google Cloud Platform",
    description: "由 main OpenCode runtime 透過遠端瀏覽器完成 Google 登入；main 與 workflow-test 共用 Extension data volume 中的 GCP 命名空間，日常操作使用 shell gcloud。",
    shortName: "GCP",
  }]);
});

test("install, status, login, cancel, and logout use only the selected Project config in main runtime", async () => {
  const fixture = createRuntimeFixture({ authenticatedProjects: ["other"] });
  const demoBackend = createBackend(fixture, "demo");
  const otherBackend = createBackend(fixture, "other");

  const installed = await request(demoBackend, "POST", "install");
  assert.deepEqual(installed.body, { project: "demo", runtime: "main", state: "ready", version: "558.0.0" });
  const initialStatus = await request(demoBackend, "GET", "status");
  assert.deepEqual(initialStatus.body, { authenticated: false, login: "idle", project: "demo", state: "ready" });

  const login = await request(demoBackend, "POST", "login");
  assert.equal(login.body.state, "pending");
  assert.match(login.body.browserUrl, /^\/browser-remote\/session\/[A-Za-z0-9_-]{43}\/$/);
  assert.equal(typeof login.body.expiresAt, "number");
  assert.equal(JSON.stringify(login.body).includes("synthetic-state-123"), false);
  assert.equal(JSON.stringify(login.body).includes("synthetic-code"), false);
  assert.equal(JSON.stringify(login.body).includes("synthetic-account"), false);
  assert.deepEqual(fixture.browserCalls.filter(({ path }) => path === "/gcloud/callbacks").map(({ body }) => body?.project), ["demo"]);

  fixture.authenticatedProjects.add("demo");
  fixture.activeProjects.delete("demo");
  const authenticated = await request(demoBackend, "GET", "status");
  assert.deepEqual(authenticated.body, { authenticated: true, login: "succeeded", project: "demo", state: "ready" });
  assert.equal(fixture.activeProjects.has("demo"), false);

  await request(demoBackend, "POST", "logout");
  assert.equal(fixture.authenticatedProjects.has("demo"), false);
  const otherStatus = await request(otherBackend, "GET", "status", "other");
  assert.equal(otherStatus.body.authenticated, true);
  assert.ok(fixture.configPaths.includes(`${runtimeConfigRoot}/demo`));
  assert.ok(fixture.configPaths.includes(`${runtimeConfigRoot}/other`));
  assert.equal(fixture.configPaths.some((path) => path === runtimeConfigRoot), false);
  assertNoDedicatedGcloudContainerLifecycle(fixture.dockerCalls);
});

test("login requests for one Project share a single synthetic browser authorization flow", async () => {
  const fixture = createRuntimeFixture();
  const backend = createBackend(fixture, "demo");
  const [first, second] = await Promise.all([
    request(backend, "POST", "login"),
    request(backend, "POST", "login"),
  ]);

  assert.deepEqual(first.body, second.body);
  assert.equal(fixture.browserCalls.filter(({ method, path }) => method === "POST" && path === "/gcloud/callbacks").length, 1);
  assert.equal(fixture.loginStartCount, 1);
  assertNoDedicatedGcloudContainerLifecycle(fixture.dockerCalls);
});

test("login failure tears down the synthetic process and callback registration", async () => {
  const fixture = createRuntimeFixture();
  fixture.browserFailurePath = "/sessions";
  const backend = createBackend(fixture, "demo");

  await assert.rejects(request(backend, "POST", "login"), (error: any) => error.code === "GCP_BROWSER_REMOTE_REQUEST_FAILED");
  assert.equal(fixture.activeProjects.has("demo"), false);
  assert.ok(fixture.browserCalls.some(({ method, path }) => method === "DELETE" && path === "/gcloud/callbacks/synthetic-state-123"));
  assert.ok(fixture.clearedLoginProjects.has("demo"));
});

test("cancel stops only the pending Project process and logout cannot affect another Project", async () => {
  const fixture = createRuntimeFixture({ authenticatedProjects: ["other"] });
  const demoBackend = createBackend(fixture, "demo");
  await request(demoBackend, "POST", "login");
  assert.equal(fixture.activeProjects.has("demo"), true);

  const cancelled = await request(demoBackend, "POST", "cancel");
  assert.deepEqual(cancelled.body, { cancelled: true, authenticated: false, project: "demo" });
  assert.equal(fixture.activeProjects.has("demo"), false);
  assert.ok(fixture.browserCalls.some(({ method, path, body }) => method === "POST" && path === "/gcloud/callbacks/cancel" && body?.project === "demo"));
  assert.ok(fixture.configPaths.filter((path) => path.endsWith("/demo")).length > 0);
  assert.equal(fixture.configPaths.some((path) => path.endsWith("/other")), false);
});

test("cancel reports a login completed during process stop and preserves another Project login", async () => {
  const fixture = createRuntimeFixture({ lateCallbackOnStop: true, stopChecksBeforeExit: 2 });
  const demoBackend = createBackend(fixture, "demo");
  const otherBackend = createBackend(fixture, "other");
  await request(otherBackend, "POST", "login", "other");
  await request(demoBackend, "POST", "login", "demo");
  const otherArtifactClearCount = fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length;

  const cancelled = await request(demoBackend, "POST", "cancel", "demo");

  assert.deepEqual(cancelled.body, { cancelled: false, authenticated: true, project: "demo" });
  assert.equal(fixture.authenticatedProjects.has("demo"), true);
  assert.equal(fixture.activeProjects.has("demo"), false);
  assert.equal(fixture.authenticatedProjects.has("other"), false);
  assert.equal(fixture.activeProjects.has("other"), true);
  assert.ok(fixture.executionEvents.includes("late-callback-during-stop:demo"));
  const demoStoppedAt = fixture.executionEvents.indexOf("login-process-stopped:demo");
  assert.ok(demoStoppedAt >= 0);
  assert.ok(fixture.executionEvents.lastIndexOf("auth-status-read:demo") > demoStoppedAt);
  assert.equal(fixture.executionEvents.includes("credentials-revoked:demo"), false);
  assert.equal(fixture.clearedLoginProjects.has("demo"), true);
  assert.equal(fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length, otherArtifactClearCount);
  assert.deepEqual(fixture.browserCalls
    .filter(({ method, path }) => method === "POST" && path === "/gcloud/callbacks/cancel")
    .map(({ body }) => body?.project), ["demo"]);

  const demoStatus = await request(demoBackend, "GET", "status", "demo");
  assert.deepEqual(demoStatus.body, { authenticated: true, login: "succeeded", project: "demo", state: "ready" });
  assert.equal(fixture.browserCalls.some(({ method, path }) => method === "DELETE" && path === "/gcloud/callbacks/synthetic-state-123"), false);

  const otherStatus = await request(otherBackend, "GET", "status", "other");
  assert.deepEqual(otherStatus.body, { authenticated: false, login: "pending", project: "other", state: "ready" });
  assert.equal(fixture.activeProjects.has("other"), true);
  assert.equal(fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length, otherArtifactClearCount);
});

test("cancel rechecks auth when callback completes before an inactive-process early return", async () => {
  const fixture = createRuntimeFixture();
  const demoBackend = createBackend(fixture, "demo");
  const otherBackend = createBackend(fixture, "other");
  await request(otherBackend, "POST", "login", "other");
  await request(demoBackend, "POST", "login", "demo");
  fixture.activeProjects.delete("demo");
  fixture.lateCallbackBeforeInactiveCheckProjects.add("demo");
  const otherArtifactClearCount = fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length;
  const beforeCancelEvents = fixture.executionEvents.length;

  const cancelled = await request(demoBackend, "POST", "cancel", "demo");

  assert.deepEqual(cancelled.body, { cancelled: false, authenticated: true, project: "demo" });
  const cancelEvents = fixture.executionEvents.slice(beforeCancelEvents);
  const firstAuthRead = cancelEvents.indexOf("auth-status-read:demo");
  const callbackCompleted = cancelEvents.indexOf("late-callback-before-inactive-check:demo");
  const inactiveCheck = cancelEvents.indexOf("login-process-liveness-read:demo:false");
  const finalAuthRead = cancelEvents.lastIndexOf("auth-status-read:demo");
  assert.ok(firstAuthRead >= 0 && firstAuthRead < callbackCompleted);
  assert.ok(callbackCompleted < inactiveCheck && inactiveCheck < finalAuthRead);
  assert.equal(fixture.authenticatedProjects.has("demo"), true);
  assert.equal(fixture.activeProjects.has("demo"), false);
  assert.equal(fixture.executionEvents.includes("credentials-revoked:demo"), false);
  assert.equal(fixture.clearedLoginProjects.has("demo"), true);
  assert.ok(fixture.executionEvents.includes("callback-session-cleaned:demo"));
  assert.deepEqual(fixture.browserCalls
    .filter(({ method, path }) => method === "POST" && path === "/gcloud/callbacks/cancel")
    .map(({ body }) => body?.project), ["demo"]);
  assert.equal(fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length, otherArtifactClearCount);

  const demoStatus = await request(demoBackend, "GET", "status", "demo");
  assert.deepEqual(demoStatus.body, { authenticated: true, login: "succeeded", project: "demo", state: "ready" });
  const otherStatus = await request(otherBackend, "GET", "status", "other");
  assert.deepEqual(otherStatus.body, { authenticated: false, login: "pending", project: "other", state: "ready" });
  assert.equal(fixture.activeProjects.has("other"), true);
  assert.equal(fixture.authenticatedProjects.has("other"), false);
  assert.equal(fixture.executionEvents.filter((event: string) => event === "login-artifacts-cleared:other").length, otherArtifactClearCount);
});

test("logout stops pending login before callback cleanup and revoke, including a late callback race", async () => {
  const fixture = createRuntimeFixture({ authenticatedProjects: ["other"], lateCallbackOnStop: true, stopChecksBeforeExit: 2 });
  const demoBackend = createBackend(fixture, "demo");

  await request(demoBackend, "POST", "login");
  assert.equal(fixture.activeProjects.has("demo"), true);

  const loggedOut = await request(demoBackend, "POST", "logout");

  assert.deepEqual(loggedOut.body, { authenticated: false, project: "demo" });
  assert.equal(fixture.activeProjects.has("demo"), false);
  assert.equal(fixture.authenticatedProjects.has("demo"), false);
  assert.equal(fixture.authenticatedProjects.has("other"), true);
  assert.ok(fixture.executionEvents.includes("late-callback-during-stop:demo"));
  assert.ok(fixture.browserCalls.some(({ method, path, body }) => method === "POST" && path === "/gcloud/callbacks/cancel" && body?.project === "demo"));
  assert.ok(fixture.executionEvents.indexOf("login-process-stopped:demo") < fixture.executionEvents.indexOf("callback-session-cleaned:demo"));
  assert.ok(fixture.executionEvents.indexOf("callback-session-cleaned:demo") < fixture.executionEvents.lastIndexOf("login-artifacts-cleared:demo"));
  assert.ok(fixture.executionEvents.lastIndexOf("login-artifacts-cleared:demo") < fixture.executionEvents.indexOf("credentials-revoked:demo"));
  assert.equal(fixture.configPaths.some((path) => path.endsWith("/other")), false);
});

test("main runtime preflight fails closed on an unexpected gcloud version", async () => {
  const fixture = createRuntimeFixture({ gcloudVersion: "999.0.0" });
  const backend = createBackend(fixture, "demo");

  await assert.rejects(request(backend, "POST", "install"), (error: any) => error.code === "GCP_RUNTIME_PREFLIGHT_FAILED");
  assertNoDedicatedGcloudContainerLifecycle(fixture.dockerCalls);
  assert.equal(fixture.projectConfigWrites.has("demo"), false);
});

test("legacy cleanup stays unavailable until the exact install transaction is complete", async () => {
  const fixture = createRuntimeFixture({ legacy: createLegacyResources("demo") });
  const backend = createBackend(fixture, "demo");

  const unknown = await request(backend, "GET", "legacy-cleanup", "demo", "outcome-unknown");
  assert.deepEqual(unknown.body, { available: false, project: "demo", reason: "INSTALL_NOT_COMPLETE" });
  await assert.rejects(request(backend, "POST", "legacy-cleanup", "demo", "lifecycle-completed"), (error: any) => error.code === "GCP_LEGACY_CLEANUP_NOT_READY");
  assert.equal(fixture.dockerCalls.some(({ method, path }) => method === "DELETE" && path.includes("agent-system-google-cloud-platform-demo")), false);
  assert.equal(fixture.legacy.containerPresent, true);
  assert.equal(fixture.legacy.volumePresent, true);
});

test("legacy cleanup removes only the exact verified Project container and its sole volume", async () => {
  const fixture = createRuntimeFixture({ legacy: createLegacyResources("demo") });
  const backend = createBackend(fixture, "demo");

  const available = await request(backend, "GET", "legacy-cleanup", "demo", "completed");
  assert.deepEqual(available.body, { available: true, project: "demo", reason: "READY" });
  const result = await request(backend, "POST", "legacy-cleanup", "demo", "completed");
  assert.deepEqual(result.body, { cleaned: true, removedContainer: true, removedVolume: true, project: "demo" });
  assert.equal(fixture.legacy.containerPresent, false);
  assert.equal(fixture.legacy.volumePresent, false);
  assert.ok(fixture.dockerCalls.some(({ method, path }) => method === "POST" && path.startsWith("/containers/legacy-container-id/stop")));
  assert.ok(fixture.dockerCalls.some(({ method, path }) => method === "DELETE" && path === "/containers/legacy-container-id?force=true&v=false"));
  assert.ok(fixture.dockerCalls.some(({ method, path }) => method === "DELETE" && path === "/volumes/agent-system-google-cloud-platform-demo-data"));
  assertNoDedicatedGcloudContainerLifecycle(fixture.dockerCalls);
});

for (const [caseName, overrides] of [
  ["another Project owner", { container: { Config: { Labels: { "agent-system.project": "other" } } } }],
  ["wrong extension label", { container: { Config: { Labels: { "agent-system.extension": "other-extension" } } } }],
  ["unexpected mount", { container: { Mounts: [{ Destination: "/root/.config/other", Type: "volume", Name: "agent-system-google-cloud-platform-demo-data" }] } }],
  ["wrong volume identity", { volume: { Name: "different-volume" } }],
  ["foreign volume consumer", { consumers: [{ Id: "legacy-container-id", Names: ["/agent-system-google-cloud-platform-demo"] }, { Id: "foreign-container-id", Names: ["/foreign-consumer"] }] }],
]) {
  test(`legacy cleanup preserves resources when ownership cannot be verified: ${caseName}`, async () => {
    const fixture = createRuntimeFixture({ legacy: createLegacyResources("demo", overrides) });
    const backend = createBackend(fixture, "demo");

    const available = await request(backend, "GET", "legacy-cleanup", "demo", "completed");
    assert.equal(available.body.available, false);
    await assert.rejects(request(backend, "POST", "legacy-cleanup", "demo", "completed"));
    assert.equal(fixture.legacy.containerPresent, true);
    assert.equal(fixture.legacy.volumePresent, true);
    assert.equal(fixture.dockerCalls.some(({ method }) => method === "DELETE"), false);
  });
}

test("legacy cleanup reports a partial failure without deleting any other resource", async () => {
  const fixture = createRuntimeFixture({ legacy: createLegacyResources("demo", { volumeDeleteStatus: 500 }) });
  const backend = createBackend(fixture, "demo");

  await assert.rejects(request(backend, "POST", "legacy-cleanup", "demo", "completed"), (error: any) => error.code === "GCP_LEGACY_CLEANUP_PARTIAL");
  assert.equal(fixture.legacy.containerPresent, false);
  assert.equal(fixture.legacy.volumePresent, true);
  assert.deepEqual(fixture.dockerCalls.filter(({ method }) => method === "DELETE").map(({ path }) => path), [
    "/containers/legacy-container-id?force=true&v=false",
    "/volumes/agent-system-google-cloud-platform-demo-data",
  ]);
});

test("legacy cleanup requires the main runtime and shared-volume preflight on each request", async () => {
  const fixture = createRuntimeFixture({ legacy: createLegacyResources("demo"), gcloudVersion: "999.0.0" });
  const backend = createBackend(fixture, "demo");

  const available = await request(backend, "GET", "legacy-cleanup", "demo", "completed");
  assert.equal(available.body.available, false);
  await assert.rejects(request(backend, "POST", "legacy-cleanup", "demo", "completed"), (error: any) => error.code === "GCP_RUNTIME_PREFLIGHT_FAILED");
  assert.equal(fixture.legacy.containerPresent, true);
  assert.equal(fixture.legacy.volumePresent, true);
});

test("callback URL parsing accepts only a gcloud localhost listener and browser URLs stay same-origin paths", () => {
  assert.deepEqual(parseAuthorizationCallback(syntheticAuthorizationUrl), { port: 34001, state: "synthetic-state-123" });
  assert.throws(() => parseAuthorizationCallback("https://accounts.google.com/auth?state=synthetic-state-123&redirect_uri=https%3A%2F%2Fexample.invalid%2F"), /unsupported OAuth callback address/);
  assert.equal(buildBrowserRemoteUrl("synthetic-session-token"), "/browser-remote/session/synthetic-session-token/");
});

function createBackend(fixture: ReturnType<typeof createRuntimeFixture>, project: string) {
  return createGoogleCloudPlatformBackend({ project }, {
    browserRemoteRequest: fixture.browserRemoteRequest,
    dockerRequest: fixture.dockerRequest,
    now: () => 1_000,
    runtimeContainerName: runtimeName,
  });
}

function request(backend: ReturnType<typeof createGoogleCloudPlatformBackend>, method: string, path: string, project = "demo", installOperationStage?: string) {
  return backend.handle({
    host: { project, ...(installOperationStage ? { installOperationStage } : {}) },
    request: { body: {}, headers: {}, method, path, query: {} },
  });
}

function createRuntimeFixture(options: {
  authenticatedProjects?: string[];
  browserFailurePath?: string;
  gcloudVersion?: string;
  lateCallbackOnStop?: boolean;
  stopChecksBeforeExit?: number;
  legacy?: ReturnType<typeof createLegacyResources>;
} = {}) {
  const fixture: any = {
    activeProjects: new Set<string>(),
    authenticatedProjects: new Set(options.authenticatedProjects ?? []),
    browserCalls: [] as Array<{ body?: Record<string, any>; method: string; path: string }>,
    clearedLoginProjects: new Set<string>(),
    configPaths: [] as string[],
    executionEvents: [] as string[],
    projectConfigWrites: new Set<string>(),
    dockerCalls: [] as Array<{ body?: Record<string, any>; method: string; path: string }>,
    executions: new Map<string, { exitCode: number; output: string }>(),
    stopChecksRemaining: new Map<string, number>(),
    lateCallbackBeforeInactiveCheckProjects: new Set<string>(),
    legacy: options.legacy ?? createLegacyResources("demo", { absent: true }),
    loginStartCount: 0,
    nextExecId: 0,
    browserFailurePath: options.browserFailurePath,
    gcloudVersion: options.gcloudVersion ?? "558.0.0",
  };

  fixture.dockerRequest = async (method: string, path: string, body?: Record<string, any>) => {
    fixture.dockerCalls.push({ method, path, ...(body ? { body } : {}) });
    const decodedPath = decodeURIComponent(path.split("?", 1)[0]!);
    if (method === "GET" && decodedPath === `/containers/${runtimeName}/json`) {
      return {
        status: 200,
        body: {
          Name: `/${runtimeName}`,
          State: { Running: true },
          Config: {
            Env: [`AGENT_SYSTEM_EXTENSION_DATA_ROOT=${runtimeExtensionDataRoot}`],
            Labels: { "com.docker.compose.service": "opencode-server" },
          },
          Mounts: [{ Destination: runtimeExtensionDataRoot, Name: sharedVolumeName, Type: "volume" }],
        },
      };
    }
    if (method === "POST" && decodedPath === `/containers/${runtimeName}/exec`) {
      const id = `synthetic-exec-${String(++fixture.nextExecId).padStart(4, "0")}`;
      fixture.executions.set(id, { exitCode: 0, output: "" });
      (fixture.executions.get(id) as any).command = body?.Cmd;
      (fixture.executions.get(id) as any).env = body?.Env;
      return { status: 201, body: { Id: id } };
    }
    const startExec = decodedPath.match(/^\/exec\/(synthetic-exec-[0-9]+)\/start$/);
    if (method === "POST" && startExec) {
      const execution = fixture.executions.get(startExec[1]!) as any;
      const outcome = fixture.runRuntimeCommand(execution.command, execution.env);
      fixture.executions.set(startExec[1]!, { exitCode: outcome.exitCode, output: outcome.stdout });
      return { status: 200, text: dockerStream(outcome.stdout, outcome.stderr), truncated: false };
    }
    const inspectExec = decodedPath.match(/^\/exec\/(synthetic-exec-[0-9]+)\/json$/);
    if (method === "GET" && inspectExec) {
      const execution = fixture.executions.get(inspectExec[1]!);
      return { status: 200, body: { ExitCode: execution?.exitCode ?? 1, Running: false } };
    }

    const legacyName = "agent-system-google-cloud-platform-demo";
    const legacyVolumeName = `${legacyName}-data`;
    if (method === "GET" && decodedPath === `/containers/${legacyName}/json`) {
      return fixture.legacy.containerPresent ? { status: 200, body: fixture.legacy.container } : { status: 404, body: {} };
    }
    if (method === "GET" && decodedPath === `/volumes/${legacyVolumeName}`) {
      return fixture.legacy.volumePresent ? { status: 200, body: fixture.legacy.volume } : { status: 404, body: {} };
    }
    if (method === "GET" && decodedPath === "/containers/json") return { status: 200, body: fixture.legacy.consumers };
    if (method === "POST" && decodedPath === "/containers/legacy-container-id/stop") return { status: 204, body: undefined };
    if (method === "DELETE" && decodedPath === "/containers/legacy-container-id") {
      fixture.legacy.containerPresent = false;
      return { status: 204, body: undefined };
    }
    if (method === "DELETE" && decodedPath === `/volumes/${legacyVolumeName}`) {
      if (fixture.legacy.volumeDeleteStatus === 204) fixture.legacy.volumePresent = false;
      return { status: fixture.legacy.volumeDeleteStatus, body: undefined };
    }
    throw new Error(`Unexpected synthetic Docker API request: ${method} ${path}`);
  };

  fixture.runRuntimeCommand = (command: string[], env: string[] = []) => {
    const config = env.find((value) => value.startsWith("CLOUDSDK_CONFIG="))?.slice("CLOUDSDK_CONFIG=".length);
    if (config) fixture.configPaths.push(config);
    const project = config?.split("/").at(-1) ?? "";
    const fullCommand = command.join(" ");
    if (fullCommand.includes("mkdir -p")) fixture.projectConfigWrites.add(project);
    if (command[0] === "gcloud" && command[1] === "version") {
      return { exitCode: 0, stdout: `Google Cloud SDK ${fixture.gcloudVersion}\n`, stderr: "synthetic version diagnostic\n" };
    }
    if (command[0] === "gcloud" && command[1] === "auth" && command[2] === "list") {
      fixture.executionEvents.push(`auth-status-read:${project}`);
      const accounts = fixture.authenticatedProjects.has(project) ? [{ account: "synthetic-account" }] : [];
      return { exitCode: 0, stdout: JSON.stringify(accounts), stderr: "synthetic auth-list diagnostic\n" };
    }
    if (command[0] === "gcloud" && command[1] === "auth" && command[2] === "revoke") {
      fixture.authenticatedProjects.delete(project);
      fixture.executionEvents.push(`credentials-revoked:${project}`);
      if (fixture.activeProjects.has(project)) {
        fixture.executionEvents.push(`late-callback-after-revoke:${project}`);
        fixture.authenticatedProjects.add(project);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (fullCommand.includes("kill -TERM") || fullCommand.includes("kill -KILL")) {
      if (options.lateCallbackOnStop && fixture.activeProjects.has(project)) {
        fixture.executionEvents.push(`late-callback-during-stop:${project}`);
        fixture.authenticatedProjects.add(project);
      }
      fixture.stopChecksRemaining.set(project, fullCommand.includes("kill -KILL") ? 0 : (options.stopChecksBeforeExit ?? 0));
      if (!fixture.stopChecksRemaining.get(project)) {
        fixture.activeProjects.delete(project);
        fixture.executionEvents.push(`login-process-stopped:${project}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (fullCommand.includes("gcloud auth login --brief")) {
      fixture.activeProjects.add(project);
      fixture.executionEvents.push(`login-process-started:${project}`);
      fixture.loginStartCount += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (fullCommand.includes("grep -Eq") && fullCommand.includes("/proc/")) {
      if (fixture.activeProjects.has(project) && fixture.stopChecksRemaining.has(project)) {
        const remaining = fixture.stopChecksRemaining.get(project) - 1;
        fixture.stopChecksRemaining.set(project, remaining);
        if (remaining <= 0) {
          fixture.activeProjects.delete(project);
          fixture.stopChecksRemaining.delete(project);
          fixture.executionEvents.push(`login-process-stopped:${project}`);
        }
      }
      if (fixture.lateCallbackBeforeInactiveCheckProjects.delete(project)) {
        fixture.authenticatedProjects.add(project);
        fixture.executionEvents.push(`late-callback-before-inactive-check:${project}`);
      }
      const active = fixture.activeProjects.has(project);
      fixture.executionEvents.push(`login-process-liveness-read:${project}:${active}`);
      return { exitCode: active ? 0 : 1, stdout: active ? "active" : "", stderr: "" };
    }
    if (fullCommand.includes("cat '") && fullCommand.includes(".log'")) {
      return { exitCode: 0, stdout: syntheticAuthorizationUrl, stderr: "" };
    }
    if (fullCommand.includes("rm -f")) {
      fixture.clearedLoginProjects.add(project);
      fixture.executionEvents.push(`login-artifacts-cleared:${project}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  fixture.browserRemoteRequest = async (method: string, path: string, body?: Record<string, any>) => {
    fixture.browserCalls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "POST" && path === "/gcloud/callbacks/cancel") {
      fixture.executionEvents.push(`callback-session-cleaned:${body?.project}`);
    }
    if (fixture.browserFailurePath === path) throw Object.assign(new Error("synthetic browser failure"), { code: "GCP_BROWSER_REMOTE_REQUEST_FAILED" });
    if (method === "POST" && path.endsWith("/api/tabs")) return { id: "synthetic-tab-123" };
    return { ok: true };
  };

  return fixture;
}

function createLegacyResources(project: string, overrides: Record<string, any> = {}) {
  const name = `agent-system-google-cloud-platform-${project}`;
  const volumeName = `${name}-data`;
  const container = {
    Id: "legacy-container-id",
    Name: `/${name}`,
    State: { Running: true },
    Config: {
      Env: [`AGENT_SYSTEM_PROJECT=${project}`, "GCP_CLI_CALLBACK_PROXY_VERSION=2"],
      Image: "gcr.io/google.com/cloudsdktool/google-cloud-cli:558.0.0-stable",
      Labels: { "agent-system.extension": "google-cloud-platform", "agent-system.project": project },
    },
    HostConfig: { Binds: [`${volumeName}:/root/.config/gcloud`] },
    Mounts: [{ Destination: "/root/.config/gcloud", Name: volumeName, Type: "volume" }],
  };
  const volume = { Labels: {}, Name: volumeName };
  const consumers = [{ Id: "legacy-container-id", Names: [`/${name}`] }];
  if (overrides.container) Object.assign(container, overrides.container);
  if (overrides.container?.Config) container.Config = { ...container.Config, ...overrides.container.Config };
  if (overrides.container?.Config?.Labels) container.Config.Labels = { ...container.Config.Labels, ...overrides.container.Config.Labels };
  if (overrides.container?.Mounts) container.Mounts = overrides.container.Mounts;
  if (overrides.volume) Object.assign(volume, overrides.volume);
  return {
    container,
    containerPresent: overrides.absent !== true,
    consumers: overrides.consumers ?? consumers,
    volume,
    volumeDeleteStatus: overrides.volumeDeleteStatus ?? 204,
    volumePresent: overrides.absent !== true,
  };
}

function dockerStream(stdout: string, stderr: string) {
  const frames: Buffer[] = [];
  for (const [stream, text] of [[1, stdout], [2, stderr]] as const) {
    const content = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(content.length, 4);
    frames.push(header, content);
  }
  return Buffer.concat(frames).toString("utf8");
}

function assertNoDedicatedGcloudContainerLifecycle(calls: Array<{ method: string; path: string }>) {
  assert.equal(calls.some(({ method, path }) => method === "POST" && /\/containers\/create/.test(path)), false);
  assert.equal(calls.some(({ method, path }) => method === "POST" && /\/containers\/[^/]+\/start(?:\?|$)/.test(path)), false);
}
