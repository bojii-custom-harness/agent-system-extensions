import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

const DATA_DESTINATION = "/var/lib/agent-system/extensions";
const DATA_ROOT = `${DATA_DESTINATION}/azure-devops-platform/projects`;
const DEFAULT_RUNTIME_IMAGE = "agent-system-extensions/azure-devops-cli-runtime:local";
const DEFAULT_RUNTIME_CONTAINER = "agent-system-opencode-server";
const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const DEFAULT_NETWORK = "agent-system-main";
const LOGIN_TTL_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const tenantCache = new Map();
const SECRET_PATTERN = /(?:bearer\s+)[A-Za-z0-9._~+/=-]+|(["']?(?:pat|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi;

export async function activate(_host = {}, dependencies = {}) {
  const docker = dependencies.docker || dockerRequest;
  const browser = dependencies.browser || browserRemoteRequest;
  const resolveTenant = dependencies.resolveTenant || resolveOrganizationTenant;
  return {
    async handle({ host, request }) {
      if (request.method !== "POST") throw extensionError(405, "ADO_METHOD_NOT_ALLOWED", "Use POST.");
      const context = readTrustedContext(request);
      const action = String(request.path || "");
      if (action === "status") return response(await readLoginStatus(host, context, docker, browser, resolveTenant));
      if (action === "login") return response(await startLogin(host, context, docker, browser, resolveTenant));
      if (action === "cancel") return response(await cancelLogin(host, context, docker, browser));
      if (action === "logout") return response(await logout(host, context, docker, browser));
      if (action === "projects") return response(await listProjects(host, context, docker));
      if (action === "configure") return response(await configureDefaults(host, context, docker));
      throw extensionError(404, "ADO_PATH_NOT_FOUND", "Azure DevOps CLI request path was not found.");
    },
  };
}

export function prepareRequest(request, { project, settings }) {
  const saved = isRecord(settings?.azureDevOps) ? settings.azureDevOps : {};
  return {
    ...request,
    trustedContext: {
      agentSystemProject: requireProject(project),
      organization: readOptionalString(saved.organization, 100),
      adoProject: readOptionalString(saved.project, 255),
    },
  };
}

export function runtimeContext(settings, project) {
  const saved = isRecord(settings?.azureDevOps) ? settings.azureDevOps : {};
  return {
    azureDevOps: {
      agentSystemProject: requireProject(project),
      organization: readOptionalString(saved.organization, 100),
      project: readOptionalString(saved.project, 255),
    },
  };
}

export function normalizeSettings(settings) {
  return isRecord(settings) ? settings : {};
}

function readTrustedContext(request) {
  const context = request?.trustedContext;
  if (!isRecord(context)) throw extensionError(400, "ADO_CONTEXT_REQUIRED", "Configure an Azure DevOps Organization and Project first.");
  const agentSystemProject = requireProject(context.agentSystemProject);
  const organization = readOptionalString(context.organization, 100);
  const adoProject = readOptionalString(context.adoProject, 255);
  if (!organization) throw extensionError(400, "ADO_ORGANIZATION_REQUIRED", "Configure an Azure DevOps Organization first.");
  return { agentSystemProject, organization: validateOrganization(organization), adoProject };
}

async function listProjects(host, context, docker) {
  await configureDefaults(host, context, docker);
  const runtime = await inspectRuntime(host, docker);
  const result = await runCommand(runtime, context, ["devops", "project", "list", "--org", organizationUrl(context.organization), "--output", "json"], docker);
  const parsed = parseJsonOutput(result.output, "ADO_PROJECT_LIST_INVALID");
  const projects = Array.isArray(parsed?.value) ? parsed.value : Array.isArray(parsed) ? parsed : undefined;
  if (!projects) throw extensionError(502, "ADO_PROJECT_LIST_INVALID", "Azure DevOps CLI returned an invalid Project list.");
  return { projects: projects.filter(isRecord).map((item) => ({
    id: safeText(item.id, 100),
    name: safeText(item.name, 255),
    state: safeText(item.state, 40),
  })).filter((item) => item.name) };
}

async function configureDefaults(host, context, docker) {
  const runtime = await inspectRuntime(host, docker);
  await runCommand(runtime, context, [
    "devops", "configure", "--defaults",
    `organization=${organizationUrl(context.organization)}`,
    `project=${context.adoProject || ""}`,
  ], docker);
  return { configured: true };
}

async function readLoginStatus(host, context, docker, browser, resolveTenant) {
  const runtime = await inspectRuntime(host, docker);
  const login = await findLoginContainer(runtime, context, docker);
  if (login?.state === "running") {
    return { authenticated: false, login: "pending", project: context.agentSystemProject, browserUrl: browserUrl(login.token) };
  }
  const tenant = await resolveTenant(context.organization);
  const account = await runCommand(runtime, context, ["account", "show", "--query", "tenantId", "--output", "json"], docker, { allowFailure: true });
  const accountTenant = account.exitCode === 0 ? parseJsonOutput(account.output, "ADO_AUTH_STATUS_INVALID", true) : undefined;
  if (typeof accountTenant === "string" && accountTenant.toLowerCase() !== tenant) {
    if (login) {
      await removeContainer(docker, login.id);
      await ignoreBrowserRequest(browser, "DELETE", `/sessions/${encodeURIComponent(login.token)}`);
    }
    return { authenticated: false, login: "tenant-mismatch", project: context.agentSystemProject };
  }
  const result = await runCommand(runtime, context, ["account", "get-access-token", "--tenant", tenant, "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "expiresOn", "--output", "json"], docker, { allowFailure: true });
  const authenticated = result.exitCode === 0;
  if (login) {
    await removeContainer(docker, login.id);
    await ignoreBrowserRequest(browser, "DELETE", `/sessions/${encodeURIComponent(login.token)}`);
  }
  return { authenticated, login: authenticated ? "succeeded" : login ? "failed" : "idle", project: context.agentSystemProject };
}

async function startLogin(host, context, docker, browser, resolveTenant) {
  const runtime = await inspectRuntime(host, docker);
  const status = await readLoginStatus(host, context, docker, browser, resolveTenant);
  if (status.authenticated) return status;
  const existing = await findLoginContainer(runtime, context, docker);
  if (existing?.state === "running") return { authenticated: false, login: "pending", project: context.agentSystemProject, browserUrl: browserUrl(existing.token) };
  const tenant = await resolveTenant(context.organization);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + LOGIN_TTL_MS;
  await browser("POST", "/sessions", { token, expiresAt });
  const containerName = loginContainerName(runtime.containerName, context.agentSystemProject);
  let created;
  try {
    created = await createContainer(runtime, context, containerName, [
    "--signal=TERM", "--kill-after=5s", "300s", "/usr/bin/az", "login", "--tenant", tenant, "--allow-no-subscriptions", "--only-show-errors",
  ], docker, {
    entrypoint: ["/usr/bin/timeout"],
    networkMode: `container:${runtime.containerName}`,
    environment: [
      "AZURE_LOGGING_ENABLE_LOG_FILE=false",
      "AZURE_CORE_LOGIN_EXPERIENCE_V2=off",
      `BROWSER=/usr/local/bin/azure-devops-browser-remote %s`,
      `BROWSER_REMOTE_SESSION_TOKEN=${token}`,
    ],
    labels: {
      "agent-system.extension": "azure-devops-platform",
      "agent-system.project": context.agentSystemProject,
      "agent-system.operation": "login",
      "agent-system.runtime": runtime.containerName,
    },
  });
    await docker("POST", `/containers/${encodeURIComponent(created.id)}/start`, undefined, 15_000);
  } catch {
    if (created) await removeContainer(docker, created.id);
    await ignoreBrowserRequest(browser, "DELETE", `/sessions/${encodeURIComponent(token)}`);
    throw extensionError(503, "ADO_LOGIN_START_FAILED", "Azure DevOps browser sign-in could not be started.");
  }
  return { authenticated: false, login: "pending", project: context.agentSystemProject, browserUrl: browserUrl(token), expiresAt };
}

async function cancelLogin(host, context, docker, browser) {
  const runtime = await inspectRuntime(host, docker);
  const login = await findLoginContainer(runtime, context, docker);
  if (!login) return { cancelled: false, project: context.agentSystemProject };
  if (login.state === "running") {
    try { await docker("POST", `/containers/${encodeURIComponent(login.id)}/stop?t=5`, undefined, 10_000); } catch {}
  }
  await removeContainer(docker, login.id);
  await ignoreBrowserRequest(browser, "DELETE", `/sessions/${encodeURIComponent(login.token)}`);
  return { cancelled: true, project: context.agentSystemProject };
}

async function logout(host, context, docker, browser) {
  await cancelLogin(host, context, docker, browser);
  const runtime = await inspectRuntime(host, docker);
  const result = await runCommand(runtime, context, ["logout", "--only-show-errors"], docker, { allowFailure: true });
  if (result.exitCode !== 0 && !/not logged in|no account/i.test(result.output)) {
    throw extensionError(503, "ADO_LOGOUT_FAILED", "Azure DevOps CLI could not complete sign-out.");
  }
  return { authenticated: false, project: context.agentSystemProject };
}

async function inspectRuntime(host, docker) {
  const containerName = process.env.OPENCODE_CONTAINER_NAME || DEFAULT_RUNTIME_CONTAINER;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(containerName)) throw extensionError(503, "ADO_RUNTIME_INVALID", "The configured OpenCode runtime identity is invalid.");
  let inspected;
  try { inspected = await docker("GET", `/containers/${encodeURIComponent(containerName)}/json`); }
  catch { throw extensionError(503, "ADO_RUNTIME_UNAVAILABLE", "The OpenCode runtime is unavailable."); }
  const container = inspected?.body;
  if (!isRecord(container) || container.State?.Running !== true
    || container.Config?.Labels?.["com.docker.compose.service"] !== "opencode-server") {
    throw extensionError(503, "ADO_RUNTIME_UNAVAILABLE", "The OpenCode runtime is not running.");
  }
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const extensionMounts = mounts.filter((mount) => mount?.Destination === DATA_DESTINATION && mount?.Type === "volume" && typeof mount.Name === "string");
  if (extensionMounts.length !== 1) throw extensionError(503, "ADO_RUNTIME_VOLUME_INVALID", "The shared Extension data volume is not mounted in the OpenCode runtime.");
  const networkName = process.env.AZURE_DEVOPS_CLI_DOCKER_NETWORK || DEFAULT_NETWORK;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(networkName)) throw extensionError(503, "ADO_RUNTIME_NETWORK_INVALID", "The Azure DevOps CLI network is invalid.");
  return {
    containerName,
    volumeName: extensionMounts[0].Name,
    volumeOptions: container.HostConfig?.Mounts?.find((mount) => mount.Target === DATA_DESTINATION)?.VolumeOptions,
    networkName,
    image: process.env.AZURE_DEVOPS_CLI_RUNTIME_IMAGE || DEFAULT_RUNTIME_IMAGE,
    configRoot: `${DATA_ROOT}/${contextProjectFromHost(host)}/.azure`,
  };
}

async function runCommand(runtime, context, command, docker, { timeoutMs = 45_000, allowFailure = false } = {}) {
  const containerName = `ado-cli-${randomBytes(10).toString("hex")}`;
  const created = await createContainer(runtime, context, containerName, command, docker, { timeoutMs });
  const startedAt = Date.now();
  try {
    const start = await docker("POST", `/containers/${encodeURIComponent(created.id)}/start`, undefined, 15_000);
    if (start.status < 200 || start.status >= 300) throw extensionError(503, "ADO_CLI_START_FAILED", "Azure DevOps CLI command could not be started.");
    let state;
    while (Date.now() - startedAt < timeoutMs) {
      const inspected = await docker("GET", `/containers/${encodeURIComponent(created.id)}/json`, undefined, 10_000);
      state = inspected.body?.State;
      if (state?.Running !== true) break;
      await delay(250);
    }
    if (state?.Running === true) {
      await stopContainer(docker, created.id);
      throw extensionError(504, "ADO_CLI_TIMEOUT", "Azure DevOps CLI command exceeded its time limit.");
    }
    const logs = await docker("GET", `/containers/${encodeURIComponent(created.id)}/logs?stdout=1&stderr=1`, undefined, 15_000, OUTPUT_LIMIT_BYTES + 8_192);
    const output = decodeDockerStream(logs.bytes || Buffer.from(logs.text || ""));
    if (logs.truncated) throw extensionError(502, "ADO_CLI_OUTPUT_TOO_LARGE", "Azure DevOps CLI command output exceeded its size limit.");
    const exitCode = state?.ExitCode;
    if (!Number.isInteger(exitCode)) throw extensionError(503, "ADO_CLI_RESULT_INVALID", "Azure DevOps CLI did not return an exit status.");
    if (!allowFailure && exitCode !== 0) {
      throw extensionError(502, "ADO_CLI_COMMAND_FAILED", redactOutput(output).slice(0, 2_000));
    }
    return { exitCode, output };
  } finally {
    await removeContainer(docker, created.id);
  }
}

async function createContainer(runtime, context, name, command, docker, { timeoutMs = COMMAND_TIMEOUT_MS, networkMode = runtime.networkName, environment = [], labels = {}, entrypoint = ["/usr/bin/az"] } = {}) {
  const configPath = `${DATA_ROOT}/${context.agentSystemProject}/.azure`;
  const payload = {
    Image: runtime.image,
    Entrypoint: entrypoint,
    Cmd: command,
    Env: [
      `AZURE_CONFIG_DIR=${configPath}`,
      "AZURE_EXTENSION_DIR=/opt/agent-system/azure-cli/extensions",
      "AZURE_LOGGING_ENABLE_LOG_FILE=false",
      "HOME=/tmp",
      // azure-devops 1.0.11 的前綴已帶底線，knack 仍會再補一個底線。
      `AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION=${organizationUrl(context.organization)}`,
      ...(context.adoProject ? [`AZURE_DEVOPS_EXT__DEFAULTS_PROJECT=${context.adoProject}`] : []),
      ...environment,
    ],
    Labels: labels,
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: 1_073_741_824,
      NanoCpus: 2_000_000_000,
      NetworkMode: networkMode,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1", compress: "false" } },
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,nosuid,size=64m" },
      Mounts: [{
        Type: "volume",
        Source: runtime.volumeName,
        Target: DATA_DESTINATION,
        ...(runtime.volumeOptions ? { VolumeOptions: runtime.volumeOptions } : {}),
      }],
    },
  };
  const result = await docker("POST", `/containers/create?name=${encodeURIComponent(name)}`, payload, timeoutMs);
  const id = result.body?.Id;
  if (result.status < 200 || result.status >= 300 || typeof id !== "string" || !/^[a-f0-9]{32,64}$/i.test(id)) {
    throw extensionError(503, "ADO_CLI_CONTAINER_CREATE_FAILED", "The Azure DevOps CLI runtime could not be created.");
  }
  return { id };
}

async function findLoginContainer(runtime, context, docker) {
  const filters = encodeURIComponent(JSON.stringify({
    label: [
      "agent-system.extension=azure-devops-platform",
      `agent-system.project=${context.agentSystemProject}`,
      "agent-system.operation=login",
      `agent-system.runtime=${runtime.containerName}`,
    ],
  }));
  const listed = await docker("GET", `/containers/json?all=1&filters=${filters}`);
  const item = Array.isArray(listed.body) ? listed.body[0] : undefined;
  if (!item || typeof item.Id !== "string") return undefined;
  const inspected = await docker("GET", `/containers/${encodeURIComponent(item.Id)}/json`);
  const env = inspected.body?.Config?.Env;
  const token = Array.isArray(env) ? env.find((value) => typeof value === "string" && value.startsWith("BROWSER_REMOTE_SESSION_TOKEN="))?.slice("BROWSER_REMOTE_SESSION_TOKEN=".length) : undefined;
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return undefined;
  return { id: item.Id, state: inspected.body?.State?.Running === true ? "running" : "exited", token };
}

async function stopContainer(docker, id) {
  try { await docker("POST", `/containers/${encodeURIComponent(id)}/stop?t=5`, undefined, 10_000); } catch {}
}

async function removeContainer(docker, id) {
  try { await docker("DELETE", `/containers/${encodeURIComponent(id)}?force=1&v=1`, undefined, 10_000); } catch {}
}

async function browserRemoteRequest(method, pathname, body) {
  const base = String(process.env.BROWSER_REMOTE_BASE_URL || "http://opencode-server:3001").replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${base}${pathname}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw extensionError(503, "ADO_BROWSER_REMOTE_UNAVAILABLE", "The Agent System browser is unavailable.");
  }
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) throw extensionError(503, "ADO_BROWSER_REMOTE_FAILED", "The Agent System browser could not complete sign-in.");
  return payload;
}

async function ignoreBrowserRequest(browser, method, path) {
  try { await browser(method, path); } catch {}
}

function dockerRequest(method, pathname, body, timeoutMs = 30_000, maxResponseBytes = 1024 * 1024) {
  const socketPath = process.env.DOCKER_SOCKET_PATH || DEFAULT_DOCKER_SOCKET;
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];
    const request = httpRequest({ socketPath, method, path: `/v1.47${pathname}`, headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(JSON.stringify(body)) }),
    } }, (response) => {
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= maxResponseBytes) chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf8");
        let parsed;
        try { parsed = text ? JSON.parse(text) : undefined; } catch {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(extensionError(503, "ADO_DOCKER_REQUEST_FAILED", `Docker ${method} ${pathname.split("?")[0]} failed (HTTP ${response.statusCode}): ${redactOutput(parsed?.message || "").slice(0, 800)}`));
          return;
        }
        resolve({ status: response.statusCode || 0, body: parsed, bytes, text, truncated: size > maxResponseBytes });
      });
      response.on("error", (error) => finish(error));
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("Docker operation timed out"));
    }, timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    request.on("error", finish);
    request.on("close", () => clearTimeout(timer));
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

export function decodeDockerStream(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return (offset === buffer.length ? Buffer.concat(chunks) : buffer).toString("utf8");
}

function response(body) {
  return { headers: { "cache-control": "no-store" }, body };
}

function browserUrl(token) {
  return `/browser-remote/session/${encodeURIComponent(token)}/`;
}

function loginContainerName(runtimeName, project) {
  const suffix = createHash("sha256").update(`${runtimeName}:${project}`).digest("hex").slice(0, 24);
  return `agent-system-azure-devops-login-${suffix}`;
}

function contextProjectFromHost(host) {
  return requireProject(host?.project);
}

function projectConfigPath(context) {
  return `${DATA_ROOT}/${context.agentSystemProject}/.azure`;
}

function organizationUrl(value) {
  return `https://dev.azure.com/${encodeURIComponent(value)}`;
}

export async function resolveOrganizationTenant(organization, request = fetch) {
  validateOrganization(organization);
  const cached = tenantCache.get(organization);
  if (request === fetch && cached?.expiresAt > Date.now()) return cached.tenant;
  let result;
  try {
    result = await request(`${organizationUrl(organization)}/_apis/projects?api-version=7.1`, {
      headers: { Accept: "application/json", "X-TFS-FedAuthRedirect": "Suppress" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw extensionError(503, "ADO_TENANT_DISCOVERY_FAILED", "無法查詢 Organization 的登入租戶，請稍後重試。");
  }
  const tenant = result.headers.get("x-vss-resourcetenant")?.toLowerCase();
  if (![200, 302, 401, 403].includes(result.status) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(tenant || "")) {
    throw extensionError(502, "ADO_TENANT_DISCOVERY_FAILED", "Azure DevOps 未提供有效的 Organization 租戶，請確認 Organization 名稱。");
  }
  await result.body?.cancel();
  if (request === fetch) {
    if (tenantCache.size >= 100) tenantCache.clear();
    tenantCache.set(organization, { tenant, expiresAt: Date.now() + LOGIN_TTL_MS });
  }
  return tenant;
}

function validateOrganization(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value)) {
    throw extensionError(400, "ADO_ORGANIZATION_INVALID", "The Azure DevOps Organization name is invalid.");
  }
  return value;
}

function requireProject(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.trim())) {
    throw extensionError(400, "ADO_AGENT_SYSTEM_PROJECT_INVALID", "The current Agent System Project identity is invalid.");
  }
  return value.trim();
}

function readOptionalString(value, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value.trim();
}

function safeText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value) ? value : "";
}

function parseJsonOutput(output, code, allowInvalid = false) {
  try { return JSON.parse(output); }
  catch {
    if (allowInvalid) return undefined;
    throw extensionError(502, code, "Azure DevOps CLI returned invalid JSON.");
  }
}

function redactOutput(value) {
  return String(value).replace(SECRET_PATTERN, "[REDACTED]");
}

function extensionError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
