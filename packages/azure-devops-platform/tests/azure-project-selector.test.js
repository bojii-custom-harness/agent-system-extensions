import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAzureConfig } from "../source/runtime/azure-project-selector.mjs";

test("main／workflow-test 依 Project 與子目錄選擇相同 profile，保留明確覆寫", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "azure-selector-"));
  try {
    const projectRoots = [path.join(root, "main"), path.join(root, "workflow")];
    const configRoot = path.join(root, "credentials");
    for (const base of projectRoots) {
      await mkdir(path.join(base, "123", "nested"), { recursive: true });
      await mkdir(path.join(base, "other"), { recursive: true });
      const resolve = (cwd, env = {}) => resolveAzureConfig({ cwd, env, projectRoots, configRoot });
      assert.equal(resolve(path.join(base, "123", "nested")), path.join(configRoot, "123", ".azure"));
      assert.equal(resolve(path.join(base, "other")), path.join(configRoot, "other", ".azure"));
      assert.throws(() => resolve(base), /Project|執行 az/);
      assert.equal(resolve(root, { AZURE_CONFIG_DIR: path.join(root, "explicit") }), path.join(root, "explicit"));
      assert.throws(() => resolve(root, { AZURE_CONFIG_DIR: "" }), /絕對路徑/);
    }
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(projectRoots[0], "linked"), "junction");
    assert.throws(() => resolveAzureConfig({ cwd: path.join(projectRoots[0], "linked"), env: {}, projectRoots, configRoot }), /執行 az/);
    await mkdir(configRoot);
    await symlink(outside, path.join(configRoot, "123"), "junction");
    assert.throws(() => resolveAzureConfig({ cwd: path.join(projectRoots[0], "123"), env: {}, projectRoots, configRoot }), /符號連結/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
