import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildExtensionPackage } from "./build-extension-packages.js";
import { runBoundedCommand } from "../test-support/run-bounded-command.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = process.env.AGENT_SYSTEM_BACKEND_ROOT;
if (!host) throw new Error("請設定 AGENT_SYSTEM_BACKEND_ROOT，指向待驗證的 agent-system/backend。");
await access(join(host, "src/features/extensions/backend.ts"));
const temporary = await mkdtemp(join(tmpdir(), "extension-host-tests-"));
try {
  const backend = join(temporary, "backend");
  const tests = join(backend, "test");
  await mkdir(tests, { recursive: true });
  await writeFile(join(temporary, "package.json"), '{"type":"module"}\n');
  await symlink(resolve(host, "src"), join(backend, "src"), "junction");
  await symlink(join(root, "packages/azure-devops-platform/policy"), join(backend, "policy"), "junction");
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "junction");
  await symlink(resolve(host, "../opencode-server"), join(temporary, "opencode-server"), "junction");
  for (const id of ["azure-devops-platform", "gitlab"]) {
    const packageRoot = join(root, "packages", id);
    const { archive, files } = await buildExtensionPackage(id);
    for (const [path, content] of files) {
      const destination = join(backend, "extension-packages", id, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await writeFile(join(backend, "extension-packages", `${id}.aicxt`), archive);
    for (const entry of await readdir(join(packageRoot, "host-tests"), { withFileTypes: true })) {
      if (entry.isDirectory()) await cp(join(packageRoot, "host-tests", entry.name), join(tests, entry.name), { recursive: true });
      else if (entry.name.endsWith(".integration.ts")) {
        await cp(join(packageRoot, "host-tests", entry.name), join(tests, entry.name.replace(".integration.ts", ".test.ts")));
      }
    }
  }
  process.exitCode = await runBoundedCommand(process.execPath, [
    "--import", "tsx",
    "--import", pathToFileURL(resolve(host, "test/test-setup.ts")).href,
    "--test", "--test-concurrency=1", "--test-timeout=75000",
    ...process.argv.slice(2),
    ...((await readdir(tests)).filter((name) => name.endsWith(".test.ts")).map((name) => join(tests, name))),
  ], {
    cwd: backend,
    env: { ...process.env, DEFAULT_WORKFLOW_SOURCE_ROOT: resolve(host, "build/default-workflow-source") },
    stdio: "inherit",
    timeout: 110_000,
    windowsHide: true,
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
