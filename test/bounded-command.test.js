import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedCommand } from "../test-support/run-bounded-command.js";

test("整合測試 runner 保留正常與失敗退出碼，並可取消長駐子程序", async () => {
  assert.equal(await runBoundedCommand(process.execPath, ["-e", "process.stdout.write('繁體中文驗證\\n'); process.stderr.write('stderr\\n')"], { timeout: 5_000, stdio: "inherit" }), 0);
  assert.equal(await runBoundedCommand(process.execPath, ["-e", "process.exit(7)"], { timeout: 5_000, stdio: "inherit" }), 7);
  await assert.rejects(() => runBoundedCommand(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { timeout: 300, stdio: "inherit" }), /已終止測試程序樹/);
});
