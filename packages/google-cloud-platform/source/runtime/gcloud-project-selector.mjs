import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROJECT_ROOTS = Object.freeze([
  "/workspace/projects",
  "/workflow/projects",
]);
export const DEFAULT_EXTENSION_DATA_ROOT = "/var/lib/agent-system/extensions";
export const DEFAULT_GCLOUD_CONFIG_ROOT = `${DEFAULT_EXTENSION_DATA_ROOT}/google-cloud-platform/projects`;

const SAFE_PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function isChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== "."
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertNotSymlink(pathname) {
  try {
    if (lstatSync(pathname).isSymbolicLink()) {
      throw new Error("gcloud Project config path must not be a symbolic link");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** Resolve the default config directory for a cwd under a managed Project root. */
export function resolveGcloudConfig({
  cwd = process.cwd(),
  env = process.env,
  projectRoots = DEFAULT_PROJECT_ROOTS,
  configRoot = env.AGENT_SYSTEM_EXTENSION_DATA_ROOT
    ? path.join(env.AGENT_SYSTEM_EXTENSION_DATA_ROOT, "google-cloud-platform", "projects")
    : DEFAULT_GCLOUD_CONFIG_ROOT,
} = {}) {
  if (Object.hasOwn(env, "CLOUDSDK_CONFIG")) {
    return env.CLOUDSDK_CONFIG;
  }

  if (!path.isAbsolute(configRoot)) {
    throw new Error("gcloud Project config root must be an absolute path");
  }

  let physicalCwd;
  try {
    physicalCwd = realpathSync.native(cwd);
  } catch {
    throw new Error("gcloud cannot resolve the current working directory");
  }

  for (const configuredRoot of projectRoots) {
    let physicalRoot;
    try {
      physicalRoot = realpathSync.native(configuredRoot);
    } catch {
      continue;
    }

    if (!isChildPath(physicalRoot, physicalCwd)) {
      continue;
    }

    const relative = path.relative(physicalRoot, physicalCwd);
    const project = relative.split(path.sep, 1)[0];
    if (!SAFE_PROJECT_NAME.test(project) || project === "." || project === "..") {
      throw new Error("gcloud Project context path is unsafe");
    }

    const resolvedConfigRoot = path.resolve(configRoot);
    const projectConfig = path.resolve(resolvedConfigRoot, project);
    if (!isChildPath(resolvedConfigRoot, projectConfig)) {
      throw new Error("gcloud Project config path is unsafe");
    }
    assertNotSymlink(projectConfig);

    return projectConfig;
  }

  throw new Error(
    "gcloud requires a cwd under /workspace/projects/<project> or /workflow/projects/<project>, "
      + "or an explicit CLOUDSDK_CONFIG",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${resolveGcloudConfig()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "gcloud config selection failed"}\n`);
    process.exitCode = 2;
  }
}
