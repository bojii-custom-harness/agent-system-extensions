import { spawn, spawnSync } from "node:child_process";

/** 時限到期時終止整棵測試程序樹，避免清理暫存目錄時子程序仍在寫入。 */
export async function runBoundedCommand(command, args, { timeout, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, detached: process.platform !== "win32" });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    }, timeout);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error(`命令超過 ${timeout}ms，已終止測試程序樹。`));
      else resolve(code ?? 1);
    });
  });
}
