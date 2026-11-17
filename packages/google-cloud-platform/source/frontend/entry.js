const STYLE = `.gcp{display:grid;gap:16px;max-width:680px;margin:0 auto;padding:24px;color:var(--foreground,#172033);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}.gcp h1,.gcp p{margin:0}.gcp-card{display:grid;gap:12px;border:1px solid var(--border,#dfe4ec);border-radius:12px;background:var(--card,#fff);padding:18px}.gcp-actions{display:flex;gap:8px;flex-wrap:wrap}.gcp button{min-height:40px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;padding:0 14px;font:600 13px/1 inherit}.gcp button.secondary{background:#475467}.gcp button:disabled{cursor:not-allowed;opacity:.55}.gcp-status{min-height:22px;color:var(--muted-foreground,#687386)}.gcp-status[data-kind=error]{color:#b42318}.gcp-status[data-kind=success]{color:#067647}.gcp-retry{display:none}.gcp-retry[data-visible=true]{display:inline-flex}`;

export async function activate(host) {
  return {
    extensionId: "google-cloud-platform",
    version: "2.0.2",
    editor: { mount(container) { return mount(host, container); } },
  };
}

export async function deactivate() {}

function mount(host, container) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const root = document.createElement("section");
  root.className = "gcp";
  root.setAttribute("aria-label", "Google Cloud Platform gcloud runtime");
  root.innerHTML = `<h1>Google Cloud Platform</h1><p>gcloud CLI 在 main OpenCode runtime 執行；main 與 workflow-test runtime 共用 Extension data volume 中的 Google Cloud Platform 命名空間。</p><section class="gcp-card"><strong>Google Cloud CLI 登入</strong><p data-status class="gcp-status" role="status" aria-live="polite">正在檢查 gcloud 登入狀態。</p><div class="gcp-actions"><button data-login type="button">使用 Google 帳戶登入</button><button data-cancel class="secondary" type="button" hidden>取消登入</button><button data-retry class="gcp-retry" type="button" data-visible="false">重試登入</button><button class="secondary" data-logout type="button">登出</button></div><p>授權頁會在 Agent System 的遠端瀏覽器開啟；Google 的 localhost 回呼由 main runtime 的 gcloud listener 直接接收。</p><p>shell gcloud 可讀寫同部署所有 Project 的憑證；Project 設定目錄只是預設選擇，不是存取控制，也不提供 token 輸出封鎖。</p></section><section class="gcp-card"><strong>舊版 gcloud runtime 清理</strong><p data-cleanup-status class="gcp-status" aria-live="polite">正在檢查安裝與 runtime 預檢狀態。</p><div class="gcp-actions"><button data-cleanup class="secondary" type="button" hidden>清除此 Project 的舊版 runtime 與資料</button></div><p>只會在新版 Extension 安裝完成且 main runtime／Extension data volume 預檢通過後，提供此 Project 的明確清理操作；不會遷移舊登入資料。</p></section>`;
  container.replaceChildren(style, root);
  const status = root.querySelector("[data-status]");
  const loginButton = root.querySelector("[data-login]");
  const logoutButton = root.querySelector("[data-logout]");
  const retryButton = root.querySelector("[data-retry]");
  const cancelButton = root.querySelector("[data-cancel]");
  const cleanupStatus = root.querySelector("[data-cleanup-status]");
  const cleanupButton = root.querySelector("[data-cleanup]");
  let disposed = false;
  let attempt = 0;
  let pollingTimer;
  let popup;
  let pendingBrowserUrl;
  let loginStarted = false;
  let loginRequest;

  const showStatus = (message, kind = "") => {
    if (disposed) return;
    status.textContent = message;
    status.dataset.kind = kind;
  };
  const call = (path, method = "GET") => host.api.callExtensionBackend(path, { method, scope: "project" });
  const setRetry = (visible) => { retryButton.dataset.visible = String(visible); };
  const showCancelOutcome = (result, cancelledMessage, unknownMessage) => {
    if (result?.authenticated === true) {
      pendingBrowserUrl = undefined;
      showStatus(`已成功登入 Google Cloud（Project：${result.project || "目前 Project"}）。`, "success");
      setRetry(false);
      return;
    }
    if (result?.cancelled === true) {
      pendingBrowserUrl = undefined;
      showStatus(cancelledMessage, "error");
    } else {
      showStatus(unknownMessage, "error");
    }
    setRetry(true);
  };
  const retry = () => {
    if (pendingBrowserUrl) {
      const entry = window.open(pendingBrowserUrl, "_blank");
      if (entry) { entry.opener = null; popup = entry; setRetry(false); showStatus("等待使用者在遠端瀏覽器完成 Google 授權…"); return; }
    }
    void login();
  };
  const delay = (ms) => new Promise((resolve) => { pollingTimer = window.setTimeout(resolve, ms); });
  const refresh = async () => {
    const refreshAttempt = attempt;
    try {
      const result = await call("status");
      if (disposed || refreshAttempt !== attempt) return;
      if (attempt && result.authenticated) {
        showStatus(`已成功登入 Google Cloud（Project：${result.project}）。`, "success");
        setRetry(false);
        attempt += 1;
        return;
      }
      if (attempt === 0) {
        if (result.authenticated) showStatus(`已登入 Google Cloud（Project：${result.project}）。`, "success");
        else if (result.login === "pending") showStatus("此 Project 的登入程序正在等待遠端瀏覽器授權。");
        else showStatus(`main OpenCode runtime 的 gcloud 已就緒，尚未登入（Project：${result.project}）。`);
      }
    } catch {
      if (!disposed && refreshAttempt === attempt && attempt === 0) { showStatus("無法檢查 main OpenCode runtime 的 gcloud 狀態。請確認 runtime 與 shared volume 預檢可用。", "error"); setRetry(true); }
    }
  };
  const login = async () => {
    if (disposed || loginButton.disabled) return;
    const currentAttempt = ++attempt;
    popup = window.open("about:blank", "google-cloud-platform-gcloud-oauth");
    if (popup) { popup.opener = null; popup.document.title = "正在準備 Google 登入"; popup.document.body.textContent = "正在連線至 Agent System 遠端瀏覽器，請稍候…"; }
    loginButton.disabled = true;
    setRetry(false);
    cancelButton.hidden = false;
    showStatus("準備中：正在啟動此 Project 的 gcloud OAuth 登入程序…");
    try {
      loginStarted = true;
      loginRequest = call("login", "POST");
      const result = await loginRequest;
      if (disposed || currentAttempt !== attempt) return;
      if (result.authenticated) {
        showStatus(`已登入 Google Cloud（Project：${result.project || "目前 Project"}）。`, "success");
        cancelButton.hidden = true;
        loginStarted = false;
        return;
      }
      const url = new URL(result.browserUrl, window.location.origin);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid browser URL");
      pendingBrowserUrl = url.toString();
      if (popup && !popup.closed) popup.location.replace(url.toString());
      else {
        const opened = window.open(url.toString(), "_blank");
        if (opened) { opened.opener = null; showStatus("已在 Agent System 的遠端瀏覽器開啟 Google 登入；localhost 回呼會直接抵達 main runtime。"); }
        else { showStatus("彈出視窗遭阻擋或已關閉。請按「重試登入」開啟同源授權入口。", "error"); setRetry(true); }
      }
      if (popup && !popup.closed) showStatus("等待使用者在遠端瀏覽器完成 Google 授權…");
      const deadline = Math.min(Number(result.expiresAt) || Date.now() + 5 * 60_000, Date.now() + 5 * 60_000);
      while (!disposed && currentAttempt === attempt && Date.now() < deadline) {
        await delay(2_000);
        if (disposed || currentAttempt !== attempt) return;
        const state = await call("status");
        if (disposed || currentAttempt !== attempt) return;
        if (state.authenticated) { showStatus(`已成功登入 Google Cloud（Project：${state.project}）。`, "success"); setRetry(false); loginStarted = false; attempt += 1; return; }
        if (state.login === "failed" || state.state === "unavailable") throw Object.assign(new Error("login failed"), { code: state.error || "GCP_LOGIN_PROCESS_FAILED", stage: state.stage || "status" });
        if (popup?.closed) {
          const cancellation = await cancelRemoteLogin();
          if (disposed || currentAttempt !== attempt) return;
          loginStarted = false;
          showCancelOutcome(cancellation, "遠端登入分頁已關閉，登入程序已取消；如需授權請重新開啟登入入口。", "遠端登入分頁已關閉，但無法確認登入程序是否取消；請重新檢查登入狀態。");
          cancelButton.hidden = true;
          return;
        }
      }
      if (disposed || currentAttempt !== attempt) return;
      const cancellation = await cancelRemoteLogin();
      if (disposed || currentAttempt !== attempt) return;
      loginStarted = false;
      cancelButton.hidden = true;
      showCancelOutcome(cancellation, "登入逾時，登入程序已取消。您可以重試登入。", "登入逾時；無法確認登入程序是否取消，請重新檢查登入狀態。");
    } catch (error) {
      if (disposed || currentAttempt !== attempt) return;
      if (popup && !popup.closed) popup.close();
      const code = typeof error?.code === "string" ? error.code : "GCP_LOGIN_SETUP_FAILED";
      const stage = code.includes("RUNTIME") || code.includes("DOCKER") ? "main runtime 預檢" : code.includes("BROWSER") ? "遠端瀏覽器建立" : code.includes("CALLBACK") || code.includes("AUTHORIZATION") || code.includes("PROCESS_FAILED") ? "授權回呼" : "登入狀態查詢";
      const message = code === "GCP_LOGIN_BUSY"
        ? "此 Project 已有 Google Cloud 登入正在進行。請等待完成或逾時後再重試。"
        : `登入失敗（${stage}，${code}）。請確認服務可用後重試。`;
      showStatus(message, "error");
      loginStarted = false;
      cancelButton.hidden = true;
      setRetry(true);
    } finally {
      if (!disposed && (currentAttempt === attempt || currentAttempt + 1 === attempt)) loginButton.disabled = false;
    }
  };
  const cancelRemoteLogin = async () => {
    if (!loginStarted) return undefined;
    loginStarted = false;
    try { await loginRequest; } catch { return undefined; }
    try { return await call("cancel", "POST"); } catch { return undefined; }
  };
  const cancel = async () => {
    if (!loginButton.disabled) return;
    attempt += 1;
    window.clearTimeout(pollingTimer);
    if (popup && !popup.closed) popup.close();
    const cancellation = await cancelRemoteLogin();
    cancelButton.hidden = true;
    loginButton.disabled = false;
    showCancelOutcome(cancellation, "已取消 Google 登入。", "無法確認 Google Cloud 登入是否已取消；請重新檢查登入狀態。");
  };
  const logout = async () => {
    logoutButton.disabled = true;
    try {
      await call("logout", "POST");
      showStatus("已登出 Google Cloud CLI。", "success");
    } catch {
      showStatus("無法登出 Google Cloud CLI。", "error");
    } finally {
      if (!disposed) logoutButton.disabled = false;
    }
  };

  const refreshCleanup = async () => {
    try {
      const result = await call("legacy-cleanup");
      if (disposed) return;
      cleanupButton.hidden = result.available !== true;
      cleanupStatus.textContent = result.available
        ? "已確認新版安裝完成、main runtime 預檢通過，且找到可精確辨識的此 Project 舊版資源。"
        : result.reason === "NO_LEGACY_RESOURCES"
          ? "此 Project 沒有可清理的舊版 gcloud runtime 資源。"
          : "尚未符合安全清理條件，或舊資源歸屬無法確認；資源會保留不動。";
    } catch {
      if (!disposed) {
        cleanupButton.hidden = true;
        cleanupStatus.textContent = "無法確認舊版資源歸屬；為安全起見不提供清理操作。";
      }
    }
  };

  const cleanupLegacy = async () => {
    if (!window.confirm("僅清除此 Project 中已驗證歸屬的舊版 gcloud runtime 與其資料 volume。舊登入資料不會遷移，完成後需重新登入。確定繼續？")) return;
    cleanupButton.disabled = true;
    cleanupStatus.textContent = "正在清除此 Project 已驗證歸屬的舊版 runtime 與資料…";
    try {
      const result = await call("legacy-cleanup", "POST");
      if (disposed) return;
      cleanupStatus.textContent = result.cleaned
        ? "此 Project 的舊版 gcloud runtime 與資料已清除；請重新登入。"
        : "沒有可清除的舊版 gcloud runtime 資源。";
      await refreshCleanup();
      if (!disposed && result.cleaned) cleanupStatus.textContent = "此 Project 的舊版 gcloud runtime 與資料已清除；請重新登入。";
    } catch {
      if (!disposed) cleanupStatus.textContent = "清理未完整完成；未確認歸屬的資源已保留，請檢查 runtime 狀態後重試。";
    } finally {
      if (!disposed) cleanupButton.disabled = false;
    }
  };

  loginButton.addEventListener("click", login);
  retryButton.addEventListener("click", retry);
  cancelButton.addEventListener("click", cancel);
  logoutButton.addEventListener("click", logout);
  cleanupButton.addEventListener("click", cleanupLegacy);
  void refresh();
  void refreshCleanup();
  return { destroy() { disposed = true; attempt += 1; window.clearTimeout(pollingTimer); void cancelRemoteLogin(); if (popup && !popup.closed && popup.location.href === "about:blank") popup.close(); loginButton.removeEventListener("click", login); retryButton.removeEventListener("click", retry); cancelButton.removeEventListener("click", cancel); logoutButton.removeEventListener("click", logout); cleanupButton.removeEventListener("click", cleanupLegacy); container.replaceChildren(); } };
}
