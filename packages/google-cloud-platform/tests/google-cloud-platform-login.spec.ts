import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

declare global {
  interface Window {
    __gcpLoginCalls?: number
    __gcpOpenCalls?: string[]
    __gcpPopupMessage?: string
    __gcpPopup?: { closed: boolean }
    __gcpOpenedPopup?: { opener: unknown; closed: boolean }
    __gcpStatusCalls?: number
    __gcpCancelCalls?: number
    __gcpCleanupCalls?: number
    __gcpCleanupConfirmations?: string[]
    __gcpConfirmResult?: boolean
    __resolveFirstStatus?: (value: unknown) => void
    __resolveLogin?: (value: unknown) => void
  }
}

const extensionEntry = await readFile(fileURLToPath(new URL("../source/frontend/entry.js", import.meta.url)), "utf8")

async function mountLoginExtension(page: import("@playwright/test").Page, apiImplementation: string) {
  await page.route("http://127.0.0.1:5174/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }))
  await page.goto("/")
  await page.setContent('<main id="extension"></main>')
  await page.evaluate(
    async ({ source, implementation }) => {
      const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
      const extension = await import(moduleUrl)
      const callExtensionBackend = new Function(`return (${implementation})`)()
      const runtime = await extension.activate({
        api: { callExtensionBackend },
      })
      const handle = runtime.editor.mount(document.querySelector("#extension"))
      ;(window as Window & { __gcpLoginExtension?: { destroy: () => void } }).__gcpLoginExtension = handle
    },
    { source: extensionEntry, implementation: apiImplementation }
  )
}

test("缺少 CLI 的已安裝套件顯示準備步驟，且不啟動登入", async ({ page }) => {
  await mountLoginExtension(page, `async (path) => {
    if (path === "status") throw Object.assign(new Error("missing CLI"), { code: "GCP_RUNTIME_PREFLIGHT_FAILED" });
    if (path === "legacy-cleanup") return { available: false };
    throw new Error("unexpected operation");
  }`)
  await expect(page.locator("[data-status]")).toContainText("Extension 已安裝")
  await expect(page.locator("[data-status]")).toContainText("Google Cloud CLI 558.0.0")
  await expect(page.locator("[data-cleanup]")).toBeHidden()
})

test("Google login shows preparation, waits for authorization, and reports the Project login result", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = (url) => {
      window.__gcpOpenCalls = [...(window.__gcpOpenCalls ?? []), String(url)]
      const body = {} as { textContent: string }
      Object.defineProperty(body, "textContent", {
        set: (value) => {
          window.__gcpPopupMessage = value
        },
      })
      return { closed: false, document: { title: "", body }, location: { replace() {} } } as unknown as Window
    }
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") return new Promise((resolve) => { window.__resolveLogin = resolve; });
    if (path === "status") { window.__gcpStatusCalls = (window.__gcpStatusCalls || 0) + 1; return window.__gcpStatusCalls > 1 ? { authenticated: true, project: "sample-project" } : { authenticated: false, project: "sample-project" }; }
    throw new Error("Unexpected Extension API request: " + path);
  })`
  )

  await expect(page.getByRole("status")).toContainText("尚未登入")
  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("準備中")
  await expect.poll(() => page.evaluate(() => window.__gcpPopupMessage)).toContain("正在連線至 Agent System 遠端瀏覽器")
  await page.evaluate(() => window.__resolveLogin?.({ browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 }))
  await expect(page.getByRole("status")).toContainText("等待使用者在遠端瀏覽器完成 Google 授權")
  await page.clock.runFor(2_000)
  await expect(page.getByRole("status")).toContainText("已成功登入 Google Cloud（Project：sample-project）")
})

test("a blocked popup leaves a retry action and never claims that the remote browser opened", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = (url) => {
      window.__gcpOpenCalls = [...(window.__gcpOpenCalls ?? []), String(url)]
      return null
    }
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") { window.__gcpLoginCalls = (window.__gcpLoginCalls || 0) + 1; return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 }; }
    return { authenticated: false, project: "sample-project" };
  })`
  )

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("彈出視窗遭阻擋或已關閉")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
  await expect(page.getByRole("status")).not.toContainText("已在 Agent System 的遠端瀏覽器開啟")
  await page.getByRole("button", { name: "重試登入" }).click()
  await expect.poll(() => page.evaluate(() => window.__gcpOpenCalls?.length ?? 0)).toBeGreaterThanOrEqual(3)
  expect(await page.evaluate(() => window.__gcpOpenCalls?.[2])).toBe("http://127.0.0.1:5174/browser-remote/?token=short-lived")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
})

test("noopener popup handles are detached securely without being mistaken for blocked popups", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    const opened = { opener: window, closed: false, document: { title: "", body: { textContent: "" } }, location: { replace() {} } }
    window.__gcpOpenedPopup = opened
    window.open = () => opened as unknown as Window
  })
  await mountLoginExtension(page, `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    return { authenticated: false, project: "sample-project" };
  })`)

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("等待使用者在遠端瀏覽器完成 Google 授權")
  expect(await page.evaluate(() => window.__gcpOpenedPopup?.opener)).toBeNull()
  await expect(page.getByRole("button", { name: "重試登入" })).toBeHidden()
})

test("closing the remote login popup is reported and leaves a retry action", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    const popup = { closed: false, document: { title: "", body: { textContent: "" } }, location: { replace() {} } }
    window.__gcpPopup = popup
    window.open = () => popup as unknown as Window
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    if (path === "cancel") { window.__gcpCancelCalls = (window.__gcpCancelCalls || 0) + 1; return { cancelled: true }; }
    return { authenticated: false, project: "sample-project" };
  })`
  )

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await page.evaluate(() => {
    if (window.__gcpPopup) window.__gcpPopup.closed = true
  })
  await page.clock.runFor(2_000)
  await expect(page.getByRole("status")).toContainText("遠端登入分頁已關閉")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__gcpCancelCalls)).toBe(1)
})

test("login setup errors and expired authorization show a retryable result", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = () => null
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") { window.__gcpLoginCalls = (window.__gcpLoginCalls || 0) + 1; if (window.__gcpLoginCalls === 1) throw Object.assign(new Error("browser unavailable"), { code: "GCP_BROWSER_REMOTE_UNAVAILABLE" }); return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 1_000 }; }
    if (path === "cancel") { window.__gcpCancelCalls = (window.__gcpCancelCalls || 0) + 1; return { cancelled: true }; }
    return { authenticated: false, project: "sample-project" };
  })`
  )

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("登入失敗（遠端瀏覽器建立，GCP_BROWSER_REMOTE_UNAVAILABLE）")
  await page.getByRole("button", { name: "重試登入" }).click()
  await expect(page.getByRole("status")).toContainText("彈出視窗遭阻擋或已關閉")
  await page.clock.runFor(2_000)
  await expect(page.getByRole("status")).toContainText("登入逾時")
  await expect.poll(() => page.evaluate(() => window.__gcpCancelCalls)).toBe(1)
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
})

test("runtime preflight and authorization callback failures expose safe, distinct stages", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = () => null
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") {
      window.__gcpLoginCalls = (window.__gcpLoginCalls || 0) + 1;
      const code = window.__gcpLoginCalls === 1 ? "GCP_RUNTIME_PREFLIGHT_FAILED" : "GCP_LOGIN_PROCESS_FAILED";
      throw Object.assign(new Error("sensitive runtime detail"), { code });
    }
    return { authenticated: false, project: "sample-project" };
  })`
  )

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("登入失敗（main runtime 預檢，GCP_RUNTIME_PREFLIGHT_FAILED）")
  await expect(page.getByRole("status")).not.toContainText("sensitive runtime detail")
  await page.getByRole("button", { name: "重試登入" }).click()
  await expect(page.getByRole("status")).toContainText("登入失敗（授權回呼，GCP_LOGIN_PROCESS_FAILED）")
  await expect(page.getByRole("status")).not.toContainText("sensitive runtime detail")
})

test("a late authorization status cannot replace a newer login attempt", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = () => {
      return { closed: false, document: { title: "", body: { textContent: "" } }, location: { replace() {} } } as unknown as Window
    }
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=attempt", expiresAt: Date.now() + 60_000 };
    window.__gcpStatusCalls = (window.__gcpStatusCalls || 0) + 1;
    if (window.__gcpStatusCalls === 1) return new Promise((resolve) => { window.__resolveFirstStatus = resolve; });
    return { authenticated: false, project: "sample-project" };
  })`
  )

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await expect(page.getByRole("status")).toContainText("等待使用者在遠端瀏覽器完成 Google 授權")
  await page.evaluate(() => window.__resolveFirstStatus?.({ authenticated: true, project: "stale-project" }))
  await expect(page.getByRole("status")).not.toContainText("stale-project")
  await expect(page.getByRole("status")).toContainText("等待使用者在遠端瀏覽器完成 Google 授權")
})

test("destroying the Extension stops pending login UI updates and further status requests", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => {
    window.open = () => null
  })
  await mountLoginExtension(
    page,
    `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    window.__gcpStatusCalls = (window.__gcpStatusCalls || 0) + 1;
    return { authenticated: false, project: "sample-project" };
  })`
  )
  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await page.evaluate(() => (window as Window & { __gcpLoginExtension?: { destroy: () => void } }).__gcpLoginExtension?.destroy())
  const countAfterDestroy = await page.evaluate(() => window.__gcpStatusCalls || 0)
  await page.clock.runFor(10_000)
  expect(await page.evaluate(() => window.__gcpStatusCalls || 0)).toBe(countAfterDestroy)
  await expect(page.locator("[data-status]")).toHaveCount(0)
})

test("explicit login cancellation asks the Project backend to stop the pending login", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => { window.open = () => null })
  await mountLoginExtension(page, `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    if (path === "cancel") { window.__gcpCancelCalls = (window.__gcpCancelCalls || 0) + 1; return { cancelled: true }; }
    return { authenticated: false, project: "sample-project" };
  })`)
  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await page.getByRole("button", { name: "取消登入" }).click()
  await expect(page.getByRole("status")).toContainText("已取消 Google 登入")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__gcpCancelCalls)).toBe(1)
})

test("cancel response that observes authentication reports success instead of cancellation", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => { window.open = () => null })
  await mountLoginExtension(page, `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    if (path === "cancel") { window.__gcpCancelCalls = (window.__gcpCancelCalls || 0) + 1; return { cancelled: false, authenticated: true, project: "sample-project" }; }
    return { authenticated: false, project: "sample-project" };
  })`)

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await page.getByRole("button", { name: "取消登入" }).click()

  await expect(page.getByRole("status")).toContainText("已成功登入 Google Cloud（Project：sample-project）")
  await expect(page.getByRole("status")).not.toContainText("已取消 Google 登入")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.__gcpCancelCalls)).toBe(1)
})

test("cancel API failure does not claim that login was cancelled", async ({ page }) => {
  await page.clock.install()
  await page.addInitScript(() => { window.open = () => null })
  await mountLoginExtension(page, `(async (path) => {
    if (path === "login") return { browserUrl: "/browser-remote/?token=short-lived", expiresAt: Date.now() + 60_000 };
    if (path === "cancel") { window.__gcpCancelCalls = (window.__gcpCancelCalls || 0) + 1; throw new Error("synthetic cancel unavailable"); }
    return { authenticated: false, project: "sample-project" };
  })`)

  await page.getByRole("button", { name: "使用 Google 帳戶登入" }).click()
  await page.getByRole("button", { name: "取消登入" }).click()

  await expect(page.getByRole("status")).toContainText("無法確認 Google Cloud 登入是否已取消")
  await expect(page.getByRole("status")).not.toContainText("已取消 Google 登入")
  await expect(page.getByRole("button", { name: "重試登入" })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__gcpCancelCalls)).toBe(1)
})

test("legacy cleanup button remains hidden when install and runtime preflight are incomplete", async ({ page }) => {
  await mountLoginExtension(page, `(async (path) => {
    if (path === "legacy-cleanup") return { available: false, project: "sample-project", reason: "INSTALL_NOT_COMPLETE" };
    return { authenticated: false, project: "sample-project" };
  })`)

  await expect(page.getByRole("button", { name: "清除此 Project 的舊版 runtime 與資料" })).toBeHidden()
  await expect(page.locator("[data-cleanup-status]")).toContainText("尚未符合安全清理條件")
})

test("legacy cleanup requires explicit confirmation and reports completion", async ({ page }) => {
  await page.addInitScript(() => {
    window.__gcpConfirmResult = false
    window.__gcpCleanupConfirmations = []
    window.confirm = (message) => {
      window.__gcpCleanupConfirmations?.push(message)
      return window.__gcpConfirmResult === true
    }
  })
  await mountLoginExtension(page, `(async (path, options) => {
    if (path === "legacy-cleanup" && options?.method === "POST") {
      window.__gcpCleanupCalls = (window.__gcpCleanupCalls || 0) + 1;
      return { cleaned: true, project: "sample-project" };
    }
    if (path === "legacy-cleanup") return window.__gcpCleanupCalls ? { available: false, reason: "NO_LEGACY_RESOURCES" } : { available: true, project: "sample-project", reason: "READY" };
    return { authenticated: false, project: "sample-project" };
  })`)

  const cleanupButton = page.getByRole("button", { name: "清除此 Project 的舊版 runtime 與資料" })
  await expect(cleanupButton).toBeVisible()
  await cleanupButton.click()
  await expect.poll(() => page.evaluate(() => window.__gcpCleanupConfirmations?.length)).toBe(1)
  expect(await page.evaluate(() => window.__gcpCleanupCalls ?? 0)).toBe(0)

  await page.evaluate(() => { window.__gcpConfirmResult = true })
  await cleanupButton.click()
  await expect.poll(() => page.evaluate(() => window.__gcpCleanupCalls)).toBe(1)
  await expect(page.getByText("此 Project 的舊版 gcloud runtime 與資料已清除；請重新登入。")).toBeVisible()
  await expect(cleanupButton).toBeHidden()
})
