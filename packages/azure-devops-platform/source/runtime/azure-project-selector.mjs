import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 依實際工作目錄選擇 Project；這是預設設定，不是檔案存取控制。 */
export function resolveAzureConfig({
  cwd = process.cwd(),
  env = process.env,
  projectRoots = ["/workspace/projects", "/workflow/projects"],
  configRoot = path.join(env.AGENT_SYSTEM_EXTENSION_DATA_ROOT || "/var/lib/agent-system/extensions", "azure-devops-platform", "projects"),
} = {}) {
  if (Object.hasOwn(env, "AZURE_CONFIG_DIR")) {
    if (!env.AZURE_CONFIG_DIR || !path.isAbsolute(env.AZURE_CONFIG_DIR)) throw new Error("AZURE_CONFIG_DIR 必須是非空的絕對路徑。");
    return env.AZURE_CONFIG_DIR;
  }
  if (!path.isAbsolute(configRoot)) throw new Error("Azure CLI 資料目錄必須是絕對路徑。");
  const physicalCwd = realpathSync(cwd);
  for (const root of projectRoots) {
    let physicalRoot;
    try { physicalRoot = realpathSync(root); } catch { continue; }
    const relative = path.relative(physicalRoot, physicalCwd);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const project = relative.split(path.sep)[0];
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(project)) throw new Error("Azure CLI Project 名稱無效。");
    const projectRoot = path.join(configRoot, project);
    for (const location of [projectRoot, path.join(projectRoot, ".azure")]) {
      try {
        if (lstatSync(location).isSymbolicLink()) throw new Error("Azure CLI Project 設定目錄不可為符號連結。");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return path.join(projectRoot, ".azure");
  }
  throw new Error("請從 /workspace/projects/<project> 或 /workflow/projects/<project> 執行 az，或明確設定 AZURE_CONFIG_DIR。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${resolveAzureConfig()}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
