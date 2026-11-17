import { randomBytes } from "node:crypto";
import path from "node:path";
import { request as httpRequest } from "node:http";

const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const RUNTIME_CONTAINER_DEFAULT = "agent-system-opencode-server";
const EXTENSION_DATA_VOLUME_DESTINATION = "/var/lib/agent-system/extensions";
const EXTENSION_DATA_ROOT = EXTENSION_DATA_VOLUME_DESTINATION;
const GCLOUD_CONFIG_ROOT = `${EXTENSION_DATA_ROOT}/google-cloud-platform/projects`;
const LEGACY_CONFIG_DESTINATION = "/root/.config/gcloud";
const LOGIN_TEMP_ROOT = "/tmp/agent-system-gcp-login";
const GOOGLE_CLOUD_CLI_VERSION = "558.0.0";
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const RUNTIME_CONTAINER_NAME = process.env.OPENCODE_CONTAINER_NAME || RUNTIME_CONTAINER_DEFAULT;
const BROWSER_REMOTE_CONTROL_URL = trimTrailingSlash(process.env.BROWSER_REMOTE_BASE_URL || "http://browser-remote:3001");

export async function activate(host = {}) {
  return createGoogleCloudPlatformBackend(host);
}

/** The factory is exported so tests can drive the package against synthetic Docker/runtime fixtures. */
export function createGoogleCloudPlatformBackend(host = {}, dependencies = {}) {
  const project = requireProject(host.project);
  const runtimeContainerName = dependencies.runtimeContainerName ?? RUNTIME_CONTAINER_NAME;
  const requestDocker = dependencies.dockerRequest ?? dockerRequest;
  const requestBrowserRemote = dependencies.browserRemoteRequest ?? browserRemoteRequest;
  const now = dependencies.now ?? Date.now;
  let pendingLogin;
  let loginInFlight;
  const logoutInFlight = new Map();
  const logoutRequested = new Set();

  return {
    async handle({ host: requestHost = {}, request }) {
      const activeProject = requireProject(requestHost.project ?? project);
      const method = String(request.method).toUpperCase();
      if (method === "POST" && request.path === "install") {
        const runtime = await preflightMainRuntime(activeProject, requestDocker, runtimeContainerName, { createProjectConfig: true });
        return { headers: noStoreHeaders(), body: { project: activeProject, runtime: "main", state: "ready", version: runtime.version } };
      }
      if (method === "GET" && request.path === "status") {
        const runtime = await preflightMainRuntime(activeProject, requestDocker, runtimeContainerName, { createProjectConfig: true });
        return { headers: noStoreHeaders(), body: await readLoginStatus(activeProject, runtime, pendingLogin, {
          requestDocker,
          requestBrowserRemote,
          runtimeContainerName,
          now,
          onPendingLoginCleared: () => { pendingLogin = undefined; },
        }) };
      }
      if (method === "POST" && request.path === "login") {
        if (logoutRequested.has(activeProject)) throw extensionError(409, "GCP_LOGOUT_IN_PROGRESS", "Google Cloud logout is already in progress for this Project.");
        if (loginInFlight) return loginInFlight;
        loginInFlight = startProjectLogin(activeProject, requestDocker, requestBrowserRemote, runtimeContainerName, now, {
          getPendingLogin: () => pendingLogin,
          setPendingLogin: (value) => { pendingLogin = value; },
        });
        try { return await loginInFlight; }
        finally { loginInFlight = undefined; }
      }
      if (method === "POST" && request.path === "cancel") {
        const runtime = await preflightMainRuntime(activeProject, requestDocker, runtimeContainerName, { createProjectConfig: true });
        const result = await cancelProjectLogin({
          project: activeProject,
          isAuthenticated: async () => (await readAuthStatus(activeProject, runtime, requestDocker, runtimeContainerName)).authenticated,
          isLoginProcessActive: () => isLoginProcessActive(activeProject, runtime, requestDocker, runtimeContainerName),
          cancelPendingLogin: () => cancelPendingLogin(activeProject, runtime, requestDocker, runtimeContainerName),
          browserRemoteRequest: requestBrowserRemote,
        });
        if (result.cancelled || result.authenticated) {
          if (pendingLogin?.project === activeProject) pendingLogin = undefined;
          await clearLoginArtifacts(activeProject, runtime, requestDocker, runtimeContainerName);
        }
        return { headers: noStoreHeaders(), body: result };
      }
      if (method === "POST" && request.path === "logout") {
        if (logoutInFlight.has(activeProject)) return logoutInFlight.get(activeProject);
        logoutRequested.add(activeProject);
        const logoutPromise = logoutProject(activeProject, runtimeContainerName, requestDocker, requestBrowserRemote, {
          getLoginInFlight: () => loginInFlight,
          clearPendingLogin: () => {
            if (pendingLogin?.project === activeProject) pendingLogin = undefined;
          },
        });
        logoutInFlight.set(activeProject, logoutPromise);
        try { return await logoutPromise; }
        finally {
          logoutInFlight.delete(activeProject);
          logoutRequested.delete(activeProject);
        }
      }
      if (method === "GET" && request.path === "legacy-cleanup") {
        return { headers: noStoreHeaders(), body: await readLegacyCleanupAvailability(
          requestHost.installOperationStage,
          activeProject,
          requestDocker,
          runtimeContainerName,
        ) };
      }
      if (method === "POST" && request.path === "legacy-cleanup") {
        if (requestHost.installOperationStage !== "completed") {
          throw extensionError(409, "GCP_LEGACY_CLEANUP_NOT_READY", "Install the current Extension and pass the main runtime preflight before cleaning legacy resources.");
        }
        await preflightMainRuntime(activeProject, requestDocker, runtimeContainerName, { createProjectConfig: false });
        const resources = await inspectLegacyResources(activeProject, requestDocker);
        if (!resources) return { headers: noStoreHeaders(), body: { cleaned: false, project: activeProject, reason: "NO_LEGACY_RESOURCES" } };
        const result = await removeLegacyResources(resources, requestDocker);
        return { headers: noStoreHeaders(), body: { ...result, project: activeProject } };
      }
      throw extensionError(404, "GCP_PATH_NOT_FOUND", "Google Cloud Platform request path is unavailable.");
    },
  };
}

async function logoutProject(project, runtimeContainerName, requestDocker, requestBrowserRemote, pendingLoginAccess) {
  const runtime = await preflightMainRuntime(project, requestDocker, runtimeContainerName, { createProjectConfig: true });
  const loginInFlight = pendingLoginAccess.getLoginInFlight();
  if (loginInFlight) {
    try { await loginInFlight; } catch { /* The login handler records its own failure and process cleanup. */ }
  }

  let stopError;
  try { await cancelPendingLogin(project, runtime, requestDocker, runtimeContainerName); }
  catch (error) { stopError = error; }

  let callbackCleanupError;
  try { await requestBrowserRemote("POST", "/gcloud/callbacks/cancel", { project }); }
  catch (error) { callbackCleanupError = error; }

  if (stopError) throw stopError;

  const artifactsCleared = await clearLoginArtifacts(project, runtime, requestDocker, runtimeContainerName);
  const revoke = await executeRuntimeCommand(runtime, project, ["gcloud", "auth", "revoke", "--all", "--quiet"], requestDocker, runtimeContainerName, { timeoutMs: 30_000, allowFailure: true });
  if (revoke.exitCode !== 0 || !artifactsCleared || callbackCleanupError) {
    throw extensionError(503, "GCP_LOGOUT_FAILED", "Google Cloud login state for this Project could not be fully cleared.");
  }
  pendingLoginAccess.clearPendingLogin();
  return { headers: noStoreHeaders(), body: { authenticated: false, project } };
}

async function startProjectLogin(project, requestDocker, requestBrowserRemote, runtimeContainerName, now, pendingLoginAccess) {
  const runtime = await preflightMainRuntime(project, requestDocker, runtimeContainerName, { createProjectConfig: true });
  const status = await readAuthStatus(project, runtime, requestDocker, runtimeContainerName);
  if (status.authenticated) return { headers: noStoreHeaders(), body: { authenticated: true, project, state: "succeeded" } };
  const currentPending = pendingLoginAccess.getPendingLogin();
  if (await isLoginProcessActive(project, runtime, requestDocker, runtimeContainerName)) {
    if (currentPending?.project === project && currentPending.expiresAt > now()) {
      return { headers: noStoreHeaders(), body: { browserUrl: currentPending.browserUrl, expiresAt: currentPending.expiresAt, state: "pending" } };
    }
    throw extensionError(409, "GCP_LOGIN_BUSY", "A Google Cloud login is already active for this Project.");
  }

  await clearLoginArtifacts(project, runtime, requestDocker, runtimeContainerName);
  try {
    await startLoginProcess(project, runtime, requestDocker, runtimeContainerName);
    const authorizationUrl = await waitForAuthorizationUrl(project, runtime, requestDocker, runtimeContainerName, now);
    const callback = parseAuthorizationCallback(authorizationUrl);
    const opened = await openBrowserRemoteLogin(project, authorizationUrl, callback.port, {
      browserRemoteRequest: requestBrowserRemote,
      now,
    });
    pendingLoginAccess.setPendingLogin({ project, state: callback.state, expiresAt: opened.expiresAt, browserUrl: opened.browserUrl });
    return { headers: noStoreHeaders(), body: { browserUrl: opened.browserUrl, expiresAt: opened.expiresAt, state: "pending" } };
  } catch (error) {
    await cancelPendingLogin(project, runtime, requestDocker, runtimeContainerName);
    await clearLoginArtifacts(project, runtime, requestDocker, runtimeContainerName);
    throw error;
  }
}

export async function cancelProjectLogin({ project, isAuthenticated, isLoginProcessActive, cancelPendingLogin: stopLogin, browserRemoteRequest: requestBrowserRemote }) {
  const authenticated = await isAuthenticated();
  if (authenticated) return { cancelled: false, authenticated: true, project };
  if (!(await isLoginProcessActive())) {
    const authenticatedAfterLiveness = await isAuthenticated();
    if (authenticatedAfterLiveness) {
      try { await requestBrowserRemote("POST", "/gcloud/callbacks/cancel", { project }); } catch { /* A completed login remains successful if browser cleanup is unavailable. */ }
    }
    return { cancelled: false, authenticated: authenticatedAfterLiveness, project };
  }
  try { await requestBrowserRemote("POST", "/gcloud/callbacks/cancel", { project }); } catch { /* Login must stop even if browser-remote is unavailable. */ }
  await stopLogin();
  const authenticatedAfterStop = await isAuthenticated();
  return { cancelled: !authenticatedAfterStop, authenticated: authenticatedAfterStop, project };
}

export async function openBrowserRemoteLogin(project, authorizationUrl, callbackPort, dependencies = {}) {
  const requestBrowserRemote = dependencies.browserRemoteRequest ?? browserRemoteRequest;
  const now = dependencies.now ?? Date.now;
  const callback = parseAuthorizationCallback(authorizationUrl);
  if (callback.port !== callbackPort) {
    throw extensionError(502, "GCP_LOGIN_CALLBACK_INVALID", "The Google Cloud CLI selected an unsupported OAuth callback address.");
  }
  const expiresAt = now() + 5 * 60 * 1000;
  const sessionToken = randomBytes(32).toString("base64url");
  let tabId;
  let callbackRegistered = false;
  let sessionRegistered = false;
  try {
    await requestBrowserRemote("POST", "/gcloud/callbacks", { callbackPort, expiresAt, project, sessionToken, state: callback.state });
    callbackRegistered = true;
    await requestBrowserRemote("POST", "/sessions", { expiresAt, token: sessionToken });
    sessionRegistered = true;
    const tab = await requestBrowserRemote("POST", `/sessions/${encodeURIComponent(sessionToken)}/api/tabs`, { url: authorizationUrl });
    tabId = typeof tab?.id === "string" ? tab.id : undefined;
    if (!tabId) throw extensionError(503, "GCP_BROWSER_TAB_CREATE_FAILED", "The server browser could not open the Google login page.");
    await requestBrowserRemote("PATCH", `/gcloud/callbacks/${encodeURIComponent(callback.state)}`, { tabId });
    await requestBrowserRemote("POST", `/sessions/${encodeURIComponent(sessionToken)}/api/tabs/${encodeURIComponent(tabId)}/activate`);
    return { browserUrl: buildBrowserRemoteUrl(sessionToken), expiresAt };
  } catch (error) {
    if (tabId) await ignoreBrowserRemoteRequest(requestBrowserRemote, "DELETE", `/sessions/${encodeURIComponent(sessionToken)}/api/tabs/${encodeURIComponent(tabId)}`);
    if (sessionRegistered) await ignoreBrowserRemoteRequest(requestBrowserRemote, "DELETE", `/sessions/${encodeURIComponent(sessionToken)}`);
    if (callbackRegistered) await ignoreBrowserRemoteRequest(requestBrowserRemote, "DELETE", `/gcloud/callbacks/${encodeURIComponent(callback.state)}`);
    throw error;
  }
}

export function buildBrowserRemoteUrl(token) {
  return `/browser-remote/session/${encodeURIComponent(token)}/`;
}

export function parseAuthorizationCallback(authorizationUrl) {
  try {
    const url = new URL(authorizationUrl);
    const redirect = new URL(url.searchParams.get("redirect_uri") || "");
    const port = Number(redirect.port);
    const state = url.searchParams.get("state") || "";
    if (url.hostname !== "accounts.google.com" || !url.pathname.startsWith("/")
      || redirect.protocol !== "http:" || redirect.hostname !== "localhost" || redirect.pathname !== "/"
      || !Number.isInteger(port) || port < 1024 || port > 65_535
      || !/^[A-Za-z0-9_-]{8,512}$/.test(state)) {
      throw new Error("invalid callback");
    }
    return { port, state };
  } catch {
    throw extensionError(502, "GCP_LOGIN_CALLBACK_INVALID", "The Google Cloud CLI selected an unsupported OAuth callback address.");
  }
}

async function preflightMainRuntime(project, requestDocker, containerName, { createProjectConfig }) {
  const runtime = await inspectMainRuntime(requestDocker, containerName);
  const configPath = projectConfigPath(runtime.configRoot, project);
  const version = await executeRuntimeCommand(runtime, project, ["gcloud", "version"], requestDocker, containerName, { timeoutMs: 30_000 });
  if (version.exitCode !== 0 || !new RegExp(`Google Cloud SDK ${GOOGLE_CLOUD_CLI_VERSION.replaceAll(".", "\\.")}\\b`).test(version.output)) {
    throw extensionError(503, "GCP_RUNTIME_PREFLIGHT_FAILED", "The main runtime does not provide the required Google Cloud CLI version.");
  }
  if (createProjectConfig) {
    const result = await executeRuntimeCommand(runtime, project, ["/bin/sh", "-lc", 'test ! -L "$CLOUDSDK_CONFIG" && mkdir -p -- "$CLOUDSDK_CONFIG" && test ! -L "$CLOUDSDK_CONFIG" && test -d "$CLOUDSDK_CONFIG" && test -w "$CLOUDSDK_CONFIG"'], requestDocker, containerName, { timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw extensionError(503, "GCP_RUNTIME_PREFLIGHT_FAILED", "The main runtime Project gcloud configuration is not writable.");
  }
  return { ...runtime, configPath, version: GOOGLE_CLOUD_CLI_VERSION };
}

async function inspectMainRuntime(requestDocker, containerName) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(containerName)) throw extensionError(503, "GCP_RUNTIME_UNAVAILABLE", "The main OpenCode runtime identity is invalid.");
  let inspected;
  try { inspected = await requestDocker("GET", `/containers/${encodeURIComponent(containerName)}/json`); }
  catch { throw extensionError(503, "GCP_RUNTIME_UNAVAILABLE", "The main OpenCode runtime is unavailable."); }
  if (inspected.status === 404 || inspected.status < 200 || inspected.status >= 300 || !isRecord(inspected.body)) {
    throw extensionError(503, "GCP_RUNTIME_UNAVAILABLE", "The main OpenCode runtime is unavailable.");
  }
  const container = inspected.body;
  if (container.Name && container.Name !== `/${containerName}` && container.Name !== containerName) {
    throw extensionError(503, "GCP_RUNTIME_IDENTITY_INVALID", "The configured main runtime identity did not match Docker.");
  }
  if (container.State?.Running !== true || container.Config?.Labels?.["com.docker.compose.service"] !== "opencode-server") {
    throw extensionError(503, "GCP_RUNTIME_UNAVAILABLE", "The main OpenCode runtime is not running.");
  }
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const sharedMounts = mounts.filter((mount) => mount?.Destination === EXTENSION_DATA_VOLUME_DESTINATION);
  if (sharedMounts.length !== 1 || sharedMounts[0].Type !== "volume" || typeof sharedMounts[0].Name !== "string" || !sharedMounts[0].Name) {
    throw extensionError(503, "GCP_RUNTIME_PREFLIGHT_FAILED", "The main runtime Extension data volume is not mounted as expected.");
  }
  const extensionDataRoot = readContainerEnvironment(container.Config?.Env, "AGENT_SYSTEM_EXTENSION_DATA_ROOT");
  const configRoot = `${EXTENSION_DATA_ROOT}/google-cloud-platform/projects`;
  if (extensionDataRoot !== EXTENSION_DATA_ROOT || !isPathWithin(EXTENSION_DATA_ROOT, configRoot)) {
    throw extensionError(503, "GCP_RUNTIME_PREFLIGHT_FAILED", "The main runtime Extension data root does not match the shared volume.");
  }
  return { containerName, configRoot, volumeName: sharedMounts[0].Name };
}

async function executeRuntimeCommand(runtime, project, command, requestDocker, containerName, { timeoutMs = 30_000, allowFailure = false } = {}) {
  const configPath = projectConfigPath(runtime.configRoot, project);
  let created;
  try {
    created = await requestDocker("POST", `/containers/${encodeURIComponent(containerName)}/exec`, {
      AttachStderr: true,
      AttachStdin: false,
      AttachStdout: true,
      Cmd: command,
      Env: [`CLOUDSDK_CONFIG=${configPath}`],
      Tty: false,
    }, timeoutMs);
  } catch {
    throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation could not be started in the main runtime.");
  }
  const execID = created.body?.Id;
  if (created.status < 200 || created.status >= 300 || typeof execID !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(execID)) {
    throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation could not be started in the main runtime.");
  }
  let started;
  try { started = await requestDocker("POST", `/exec/${encodeURIComponent(execID)}/start`, { Detach: false, Tty: false }, timeoutMs, 256 * 1024); }
  catch {
    throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation did not finish in the main runtime.");
  }
  if (started.status < 200 || started.status >= 300) throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation did not finish in the main runtime.");
  if (started.truncated) throw extensionError(503, "GCP_RUNTIME_OUTPUT_TRUNCATED", "A Google Cloud operation returned incomplete output in the main runtime.");
  const output = decodeDockerStream(started.text || "");
  let inspected;
  try { inspected = await requestDocker("GET", `/exec/${encodeURIComponent(execID)}/json`, undefined, timeoutMs); }
  catch { throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation did not finish in the main runtime."); }
  const exitCode = inspected.body?.ExitCode;
  if (inspected.status < 200 || inspected.status >= 300 || !Number.isInteger(exitCode)) {
    throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation did not finish in the main runtime.");
  }
  if (!allowFailure && exitCode !== 0) throw extensionError(503, "GCP_RUNTIME_COMMAND_FAILED", "A Google Cloud operation failed in the main runtime.");
  return { exitCode, output };
}

async function readLoginStatus(project, runtime, pendingLogin, dependencies) {
  const auth = await readAuthStatus(project, runtime, dependencies.requestDocker, dependencies.runtimeContainerName);
  if (auth.authenticated) {
    if (pendingLogin?.project === project) {
      await ignoreBrowserRemoteRequest(dependencies.requestBrowserRemote, "DELETE", `/gcloud/callbacks/${encodeURIComponent(pendingLogin.state)}`);
      dependencies.onPendingLoginCleared();
    }
    await clearLoginArtifacts(project, runtime, dependencies.requestDocker, dependencies.runtimeContainerName);
    return { authenticated: true, login: "succeeded", project, state: "ready" };
  }

  const active = await isLoginProcessActive(project, runtime, dependencies.requestDocker, dependencies.runtimeContainerName);
  if (active && (!pendingLogin || pendingLogin.expiresAt > dependencies.now())) {
    return { authenticated: false, login: "pending", project, state: "ready" };
  }
  if (pendingLogin?.project === project) {
    const timedOut = pendingLogin.expiresAt <= dependencies.now();
    if (active) await cancelPendingLogin(project, runtime, dependencies.requestDocker, dependencies.runtimeContainerName);
    await ignoreBrowserRemoteRequest(dependencies.requestBrowserRemote, "DELETE", `/gcloud/callbacks/${encodeURIComponent(pendingLogin.state)}`);
    dependencies.onPendingLoginCleared();
    await clearLoginArtifacts(project, runtime, dependencies.requestDocker, dependencies.runtimeContainerName);
    return { authenticated: false, error: timedOut ? "GCP_LOGIN_TIMEOUT" : "GCP_LOGIN_PROCESS_FAILED", login: "failed", project, state: "ready" };
  }
  return { authenticated: false, login: "idle", project, state: "ready" };
}

async function readAuthStatus(project, runtime, requestDocker, containerName) {
  const result = await executeRuntimeCommand(runtime, project, ["gcloud", "auth", "list", "--format=json"], requestDocker, containerName, { timeoutMs: 30_000 });
  let accounts;
  try { accounts = JSON.parse(result.output); } catch { accounts = undefined; }
  return { authenticated: Array.isArray(accounts) && accounts.length > 0 };
}

async function startLoginProcess(project, runtime, requestDocker, containerName) {
  const paths = loginPaths(project);
  const script = `umask 077; mkdir -p '${LOGIN_TEMP_ROOT}'; rm -f '${paths.log}' '${paths.pid}' '${paths.exit}'; ( DISPLAY=:0 BROWSER=/usr/bin/true gcloud auth login --brief > '${paths.log}' 2>&1; printf '%s' "$?" > '${paths.exit}' ) </dev/null >/dev/null 2>&1 & printf '%s' "$!" > '${paths.pid}'`;
  const result = await executeRuntimeCommand(runtime, project, ["/bin/sh", "-c", script], requestDocker, containerName, { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw extensionError(503, "GCP_LOGIN_PROCESS_START_FAILED", "The Google Cloud login process could not be started in the main runtime.");
}

async function waitForAuthorizationUrl(project, runtime, requestDocker, containerName, now) {
  const deadline = now() + 30_000;
  while (now() < deadline) {
    const output = await executeRuntimeCommand(runtime, project, ["/bin/sh", "-c", `cat '${loginPaths(project).log}' 2>/dev/null || true`], requestDocker, containerName, { timeoutMs: 10_000 });
    const authorizationUrl = extractAuthorizationUrl(output.output);
    if (authorizationUrl) return authorizationUrl;
    if (!(await isLoginProcessActive(project, runtime, requestDocker, containerName))) {
      throw extensionError(502, "GCP_LOGIN_PROCESS_FAILED", "The Google Cloud login process ended before producing an authorization URL.");
    }
    await delay(Math.min(250, Math.max(1, deadline - now())));
  }
  await cancelPendingLogin(project, runtime, requestDocker, containerName);
  throw extensionError(504, "GCP_LOGIN_URL_TIMEOUT", "The Google Cloud login process did not produce an authorization URL in time.");
}

async function isLoginProcessActive(project, runtime, requestDocker, containerName, timeoutMs = 10_000) {
  const pidPath = loginPaths(project).pid;
  const script = String.raw`has_login_process() { if [ -r "/proc/$1/cmdline" ] && tr '\000' ' ' < "/proc/$1/cmdline" | grep -Eq 'gcloud(\.py)?[[:space:]]+auth[[:space:]]+login'; then return 0; fi; for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null || true); do if has_login_process "$child"; then return 0; fi; done; return 1; }; pid=$(cat '${pidPath}' 2>/dev/null || true); case "$pid" in ''|*[!0-9]*) exit 1;; esac; if has_login_process "$pid"; then printf active; exit 0; fi; exit 1`;
  const result = await executeRuntimeCommand(runtime, project, ["/bin/sh", "-c", script], requestDocker, containerName, { timeoutMs, allowFailure: true });
  return result.exitCode === 0 && result.output.trim() === "active";
}

async function cancelPendingLogin(project, runtime, requestDocker, containerName) {
  if (!(await isLoginProcessActive(project, runtime, requestDocker, containerName))) return;
  await signalLoginProcess(project, runtime, requestDocker, containerName, "TERM");
  if (await waitForLoginProcessStop(project, runtime, requestDocker, containerName, 5_000)) return;
  await signalLoginProcess(project, runtime, requestDocker, containerName, "KILL");
  if (await waitForLoginProcessStop(project, runtime, requestDocker, containerName, 2_000)) return;
  throw extensionError(503, "GCP_LOGIN_PROCESS_STOP_FAILED", "The pending Google Cloud login process could not be stopped safely.");
}

async function signalLoginProcess(project, runtime, requestDocker, containerName, signal) {
  const paths = loginPaths(project);
  const script = String.raw`signal_login_tree() { for child in $(cat "/proc/$1/task/$1/children" 2>/dev/null || true); do signal_login_tree "$child"; done; if [ -z "$(cat "/proc/$1/task/$1/children" 2>/dev/null || true)" ] && [ -r "/proc/$1/cmdline" ] && tr '\000' ' ' < "/proc/$1/cmdline" | grep -Eq 'gcloud(\.py)?[[:space:]]+auth[[:space:]]+login'; then kill -${signal} "$1" 2>/dev/null || true; fi; }; pid=$(cat '${paths.pid}' 2>/dev/null || true); case "$pid" in ''|*[!0-9]*) ;; *) signal_login_tree "$pid";; esac`;
  await executeRuntimeCommand(runtime, project, ["/bin/sh", "-c", script], requestDocker, containerName, { timeoutMs: 10_000, allowFailure: true });
}

async function waitForLoginProcessStop(project, runtime, requestDocker, containerName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await isLoginProcessActive(project, runtime, requestDocker, containerName, 2_000))) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(100, deadline - Date.now()));
  } while (Date.now() < deadline);
  return false;
}

async function clearLoginArtifacts(project, runtime, requestDocker, containerName) {
  const paths = loginPaths(project);
  const result = await executeRuntimeCommand(runtime, project, ["/bin/sh", "-c", `rm -f '${paths.log}' '${paths.pid}' '${paths.exit}'`], requestDocker, containerName, { timeoutMs: 10_000, allowFailure: true });
  return result.exitCode === 0;
}

function extractAuthorizationUrl(output) {
  const match = String(output).match(/https:\/\/accounts\.google\.com\/[^\s"']+/);
  if (!match) return undefined;
  try {
    parseAuthorizationCallback(match[0]);
    return match[0];
  } catch {
    return undefined;
  }
}

function loginPaths(project) {
  if (!PROJECT_PATTERN.test(project)) throw extensionError(403, "GCP_PROJECT_CONTEXT_INVALID", "Google Cloud Platform requires an active Project context.");
  return {
    exit: `${LOGIN_TEMP_ROOT}/${project}.exit`,
    log: `${LOGIN_TEMP_ROOT}/${project}.log`,
    pid: `${LOGIN_TEMP_ROOT}/${project}.pid`,
  };
}

async function readLegacyCleanupAvailability(installStage, project, requestDocker, containerName) {
  if (installStage !== "completed") return { available: false, project, reason: "INSTALL_NOT_COMPLETE" };
  try {
    await preflightMainRuntime(project, requestDocker, containerName, { createProjectConfig: false });
    const resources = await inspectLegacyResources(project, requestDocker);
    return resources
      ? { available: true, project, reason: "READY" }
      : { available: false, project, reason: "NO_LEGACY_RESOURCES" };
  } catch (error) {
    return { available: false, project, reason: safeErrorCode(error) };
  }
}

async function inspectLegacyResources(project, requestDocker) {
  const containerName = legacyContainerName(project);
  const volumeName = `${containerName}-data`;
  let inspected;
  try { inspected = await requestDocker("GET", `/containers/${encodeURIComponent(containerName)}/json`); }
  catch { throw extensionError(503, "GCP_LEGACY_INSPECT_FAILED", "The legacy Project runtime could not be inspected safely."); }
  if (inspected.status === 404) {
    const orphanVolume = await requestDocker("GET", `/volumes/${encodeURIComponent(volumeName)}`);
    if (orphanVolume.status !== 404) throw extensionError(409, "GCP_LEGACY_OWNERSHIP_UNVERIFIED", "The legacy data volume has no verifiable owning runtime and was preserved.");
    return undefined;
  }
  if (inspected.status < 200 || inspected.status >= 300 || !isRecord(inspected.body)) {
    throw extensionError(503, "GCP_LEGACY_INSPECT_FAILED", "The legacy Project runtime could not be inspected safely.");
  }
  const container = inspected.body;
  const labels = container.Config?.Labels ?? {};
  const expectedName = `/${containerName}`;
  const environment = Array.isArray(container.Config?.Env) ? container.Config.Env : [];
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const matchingMounts = mounts.filter((mount) => mount?.Destination === LEGACY_CONFIG_DESTINATION);
  const expectedBind = `${volumeName}:${LEGACY_CONFIG_DESTINATION}`;
  const binds = container.HostConfig?.Binds;
  const validBinds = binds === undefined || (Array.isArray(binds) && binds.length === 1 && binds[0] === expectedBind);
  if ((container.Name !== expectedName && container.Name !== containerName)
    || labels["agent-system.extension"] !== "google-cloud-platform"
    || labels["agent-system.project"] !== project
    || !environment.includes(`AGENT_SYSTEM_PROJECT=${project}`)
    || !environment.includes("GCP_CLI_CALLBACK_PROXY_VERSION=2")
    || mounts.length !== 1
    || matchingMounts.length !== 1
    || matchingMounts[0].Type !== "volume"
    || matchingMounts[0].Name !== volumeName
    || !validBinds) {
    throw extensionError(409, "GCP_LEGACY_OWNERSHIP_UNVERIFIED", "Legacy runtime ownership or its exact Project data-volume mount could not be confirmed; resources were preserved.");
  }

  let volume;
  try { volume = await requestDocker("GET", `/volumes/${encodeURIComponent(volumeName)}`); }
  catch { throw extensionError(503, "GCP_LEGACY_VOLUME_INSPECT_FAILED", "The legacy Project data volume could not be inspected safely."); }
  if (volume.status < 200 || volume.status >= 300 || volume.body?.Name !== volumeName) {
    throw extensionError(409, "GCP_LEGACY_OWNERSHIP_UNVERIFIED", "The legacy Project data volume identity could not be confirmed; resources were preserved.");
  }
  const volumeLabels = volume.body?.Labels;
  if (isRecord(volumeLabels)
    && ((volumeLabels["agent-system.extension"] !== undefined && volumeLabels["agent-system.extension"] !== "google-cloud-platform")
      || (volumeLabels["agent-system.project"] !== undefined && volumeLabels["agent-system.project"] !== project))) {
    throw extensionError(409, "GCP_LEGACY_OWNERSHIP_UNVERIFIED", "The legacy Project data volume labels do not match; resources were preserved.");
  }

  const filters = encodeURIComponent(JSON.stringify({ volume: [volumeName] }));
  let consumers;
  try { consumers = await requestDocker("GET", `/containers/json?all=1&filters=${filters}`); }
  catch { throw extensionError(503, "GCP_LEGACY_VOLUME_INSPECT_FAILED", "Legacy data-volume consumers could not be inspected safely."); }
  if (consumers.status < 200 || consumers.status >= 300 || !Array.isArray(consumers.body)) {
    throw extensionError(503, "GCP_LEGACY_VOLUME_INSPECT_FAILED", "Legacy data-volume consumers could not be inspected safely.");
  }
  const containerID = container.Id;
  const targetConsumer = consumers.body.some((candidate) => candidate?.Id === containerID
    || (Array.isArray(candidate?.Names) && candidate.Names.includes(expectedName)));
  const foreignConsumers = consumers.body.filter((candidate) => candidate?.Id !== containerID
    && !(Array.isArray(candidate?.Names) && candidate.Names.includes(expectedName)));
  if (!targetConsumer || foreignConsumers.length > 0) {
    throw extensionError(409, "GCP_LEGACY_VOLUME_OWNERSHIP_UNVERIFIED", "The legacy data volume is shared or its consumer identity is unclear; resources were preserved.");
  }
  return { container, containerID: typeof containerID === "string" ? containerID : containerName, containerName, project, volumeName };
}

async function removeLegacyResources(resources, requestDocker) {
  if (resources.container.State?.Running === true) {
    let stopped;
    try { stopped = await requestDocker("POST", `/containers/${encodeURIComponent(resources.containerID)}/stop?t=10`); }
    catch { throw extensionError(503, "GCP_LEGACY_CLEANUP_FAILED", "The verified legacy runtime could not be stopped; its data volume was preserved."); }
    if (![204, 304].includes(stopped.status)) throw extensionError(503, "GCP_LEGACY_CLEANUP_FAILED", "The verified legacy runtime could not be stopped; its data volume was preserved.");
  }
  let removedContainer;
  try { removedContainer = await requestDocker("DELETE", `/containers/${encodeURIComponent(resources.containerID)}?force=true&v=false`); }
  catch { throw extensionError(503, "GCP_LEGACY_CLEANUP_FAILED", "The verified legacy runtime could not be removed; its data volume was preserved."); }
  if (removedContainer.status !== 204) throw extensionError(503, "GCP_LEGACY_CLEANUP_FAILED", "The verified legacy runtime could not be removed; its data volume was preserved.");

  let removedVolume;
  try { removedVolume = await requestDocker("DELETE", `/volumes/${encodeURIComponent(resources.volumeName)}`); }
  catch { throw extensionError(503, "GCP_LEGACY_CLEANUP_PARTIAL", "The legacy runtime was removed, but its verified data volume remains and needs follow-up."); }
  if (removedVolume.status !== 204 && removedVolume.status !== 404) {
    throw extensionError(503, "GCP_LEGACY_CLEANUP_PARTIAL", "The legacy runtime was removed, but its verified data volume remains and needs follow-up.");
  }
  return { cleaned: true, removedContainer: true, removedVolume: removedVolume.status === 204 };
}

function legacyContainerName(project) {
  return `agent-system-google-cloud-platform-${slugify(project)}`;
}

function projectConfigPath(configRoot, project) {
  if (!PROJECT_PATTERN.test(project) || configRoot !== GCLOUD_CONFIG_ROOT) {
    throw extensionError(403, "GCP_PROJECT_CONTEXT_INVALID", "Google Cloud Platform requires a valid Project configuration.");
  }
  const resolved = path.posix.resolve(configRoot, project);
  if (!isPathWithin(configRoot, resolved)) throw extensionError(403, "GCP_PROJECT_CONTEXT_INVALID", "The Project gcloud configuration path is invalid.");
  return resolved;
}

function isPathWithin(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

function readContainerEnvironment(values, name) {
  if (!Array.isArray(values)) return undefined;
  const prefix = `${name}=`;
  const entry = values.find((value) => typeof value === "string" && value.startsWith(prefix));
  return entry?.slice(prefix.length);
}

async function browserRemoteRequest(method, pathname, body) {
  let response;
  try {
    response = await fetch(`${BROWSER_REMOTE_CONTROL_URL}${pathname}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      method,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw extensionError(503, "GCP_BROWSER_REMOTE_UNAVAILABLE", "The server browser service is unavailable.");
  }
  if (!response.ok) {
    let failure;
    try { failure = await response.json(); } catch { failure = undefined; }
    if (failure?.code === "GCP_LOGIN_BUSY") throw extensionError(409, "GCP_LOGIN_BUSY", "This Project already has an active Google Cloud login.");
    throw extensionError(503, "GCP_BROWSER_REMOTE_REQUEST_FAILED", "The server browser could not complete the Google login setup.");
  }
  if (response.status === 204) return undefined;
  try { return await response.json(); } catch { return undefined; }
}

async function ignoreBrowserRemoteRequest(requestBrowserRemote, method, pathname) {
  try { await requestBrowserRemote(method, pathname); } catch { /* Session cleanup is best effort. */ }
}

function dockerRequest(method, pathname, body, timeoutMs = 30_000, maxResponseBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let settled = false;
    let request;
    const deadline = setTimeout(() => finish(extensionError(504, "GCP_DOCKER_TIMEOUT", "A Docker operation timed out."), true), timeoutMs);
    const finish = (error, destroy = false, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (destroy && request && !request.destroyed) request.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    try {
      request = httpRequest({
        method,
        path: pathname,
        socketPath: DOCKER_SOCKET_PATH,
        headers: serialized === undefined ? undefined : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(serialized)),
        },
      }, (response) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk) => {
          const buffer = Buffer.from(chunk);
          const remaining = Math.max(0, maxResponseBytes - size);
          if (remaining) chunks.push(buffer.subarray(0, remaining));
          if (buffer.length > remaining) truncated = true;
          size += buffer.length;
        });
        response.on("error", (error) => finish(extensionError(503, "GCP_DOCKER_UNAVAILABLE", "Docker is unavailable.")));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
          finish(undefined, false, { body: parsed, status: response.statusCode || 500, text, truncated });
        });
      });
      request.on("error", () => finish(extensionError(503, "GCP_DOCKER_UNAVAILABLE", "Docker is unavailable.")));
      request.setTimeout(timeoutMs, () => finish(extensionError(504, "GCP_DOCKER_TIMEOUT", "A Docker operation timed out."), true));
      if (serialized !== undefined) request.write(serialized);
      request.end();
    } catch {
      finish(extensionError(503, "GCP_DOCKER_UNAVAILABLE", "Docker is unavailable."), true);
    }
  });
}

function decodeDockerStream(value) {
  const data = Buffer.from(value, "utf8");
  const stdout = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const stream = data[offset];
    const length = data.readUInt32BE(offset + 4);
    if ((stream !== 1 && stream !== 2) || data[offset + 1] !== 0 || data[offset + 2] !== 0 || data[offset + 3] !== 0 || offset + 8 + length > data.length) return value;
    if (stream === 1) stdout.push(data.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  if (offset !== data.length) return value;
  return Buffer.concat(stdout).toString("utf8");
}

function requireProject(value) {
  const project = typeof value === "string" ? value.trim() : "";
  if (!PROJECT_PATTERN.test(project)) throw extensionError(403, "GCP_PROJECT_CONTEXT_INVALID", "Google Cloud Platform requires an active Project context.");
  return project;
}

function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project"; }
function trimTrailingSlash(value) { return String(value).replace(/\/+$/, ""); }
function noStoreHeaders() { return { "cache-control": "no-store" }; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeErrorCode(error) { return typeof error?.code === "string" ? error.code : "GCP_RUNTIME_PREFLIGHT_FAILED"; }
function extensionError(statusCode, code, message) { const error = new Error(message); error.statusCode = statusCode; error.code = code; return error; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
