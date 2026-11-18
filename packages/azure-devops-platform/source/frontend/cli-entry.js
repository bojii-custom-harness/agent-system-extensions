const STYLE = `
.ado-cli{display:grid;gap:16px;max-width:760px;margin:auto;padding:24px;color:var(--foreground,#172033);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.ado-cli h1,.ado-cli h2,.ado-cli p{margin:0}.ado-cli h1{font-size:22px}.ado-cli h2{font-size:15px}
.ado-cli-card{display:grid;gap:12px;border:1px solid var(--border,#dfe4ec);border-radius:14px;background:var(--card,#fff);padding:16px}
.ado-cli-field{display:grid;gap:5px;color:var(--muted-foreground,#687386);font-size:12px;font-weight:700}
.ado-cli-field input,.ado-cli-field select{min-height:38px;box-sizing:border-box;border:1px solid var(--border,#dfe4ec);border-radius:8px;background:var(--background,#fff);color:var(--foreground,#172033);padding:8px 10px;font:inherit}
.ado-cli-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.ado-cli button{min-height:38px;border:0;border-radius:8px;background:#0078d4;color:#fff;cursor:pointer;padding:0 14px;font:600 13px/1 inherit}
.ado-cli button.secondary{border:1px solid var(--border,#dfe4ec);background:var(--background,#fff);color:var(--foreground,#172033)}
.ado-cli button:disabled{cursor:not-allowed;opacity:.55}
.ado-cli-status{min-height:20px;color:var(--muted-foreground,#687386);font-size:12px}
.ado-cli-status[data-kind=error]{color:#b42318}.ado-cli-status[data-kind=success]{color:#067647}.ado-cli-status[data-kind=busy]{color:#1d4ed8}
.ado-cli-note{color:var(--muted-foreground,#687386);font-size:12px}
@media(max-width:640px){.ado-cli{padding:16px}}
`;

export async function activate(host) {
  return { editor: { mount: (container, context) => mount(container, host, context) } };
}

export async function mount(container, host, context = {}) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  const root = document.createElement("section");
  root.className = "ado-cli";
  root.setAttribute("aria-label", "Azure DevOps CLI settings");
  const projectName = typeof context.projectName === "string" ? context.projectName : "目前 Project";
  root.innerHTML = `
    <header><h1>Azure DevOps</h1><p class="ado-cli-note">Organization 與 Azure DevOps Project 設定及 Microsoft Entra SSO。Agent 透過官方 Azure DevOps CLI 執行命令。</p></header>
    <section class="ado-cli-card">
      <h2>Organization 與 Project</h2>
      <label class="ado-cli-field">Organization<input data-organization autocomplete="organization" placeholder="contoso" required></label>
      <label class="ado-cli-field">Azure DevOps Project<select data-project><option value="">請先登入並載入 Projects</option></select></label>
      <div class="ado-cli-actions"><button data-save type="button">儲存設定</button><span data-settings-status class="ado-cli-status" role="status" aria-live="polite"></span></div>
      <p class="ado-cli-note">此設定作為 Agent 的預設 CLI context。<code>az devops invoke</code> 仍可存取目前登入帳號在該 Organization 具權限的其他資源；Project 選擇不是安全隔離。</p>
    </section>
    <section class="ado-cli-card">
      <h2>Microsoft Entra SSO</h2>
      <p class="ado-cli-note">登入狀態依 Agent System Project 分開保存：${escapeHtml(projectName)}。不使用 PAT 登入流程。</p>
      <div class="ado-cli-actions">
        <button data-login type="button">使用 Microsoft 帳號登入</button>
        <button data-cancel class="secondary" type="button" hidden>取消登入</button>
        <button data-logout class="secondary" type="button">登出</button>
        <button data-refresh class="secondary" type="button">重新檢查</button>
      </div>
      <p data-auth-status class="ado-cli-status" role="status" aria-live="polite">請先設定 Organization。</p>
    </section>
  `;
  container.replaceChildren(style, root);

  const organization = root.querySelector("[data-organization]");
  const project = root.querySelector("[data-project]");
  const status = root.querySelector("[data-auth-status]");
  const settingsStatus = root.querySelector("[data-settings-status]");
  const loginButton = root.querySelector("[data-login]");
  const cancelButton = root.querySelector("[data-cancel]");
  const logoutButton = root.querySelector("[data-logout]");
  const refreshButton = root.querySelector("[data-refresh]");
  let disposed = false;
  let polling = false;
  let popup;
  let pollTimer;

  const setStatus = (message, kind = "") => { status.textContent = message; status.dataset.kind = kind; };
  const call = (path) => host.api.callExtensionBackend(path, { method: "POST", body: {}, scope: "project" });
  const readSettings = async () => {
    const value = await host.api.readExtensionSettings("project");
    return isRecord(value) ? value : {};
  };
  const saveSettings = async (patch) => {
    const settings = await readSettings();
    const current = isRecord(settings.azureDevOps) ? settings.azureDevOps : {};
    settings.azureDevOps = { ...current, ...patch };
    await host.api.writeExtensionSettings(settings, "project");
  };

  async function loadSaved() {
    try {
      const settings = await readSettings();
      const saved = isRecord(settings.azureDevOps) ? settings.azureDevOps : {};
      organization.value = typeof saved.organization === "string" ? saved.organization : "";
      const savedProject = typeof saved.project === "string" ? saved.project : "";
      if (savedProject) {
        project.add(new Option(savedProject, savedProject));
        project.value = savedProject;
      }
      if (organization.value) {
        await refreshStatus();
        if (savedProject) project.value = savedProject;
      }
    } catch (error) {
      setStatus(errorMessage(error), "error");
    }
  }

  async function saveContext() {
    const org = organization.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(org)) {
      settingsStatus.textContent = "請輸入有效 Organization 名稱。";
      settingsStatus.dataset.kind = "error";
      return;
    }
    await saveSettings({ organization: org, ...(project.value ? { project: project.value } : {}) });
    settingsStatus.textContent = "設定已儲存。";
    settingsStatus.dataset.kind = "success";
    if (project.value) await refreshProjects();
  }

  async function refreshProjects() {
    if (!organization.value.trim()) return;
    setStatus("正在使用已登入的 Azure CLI 載入 Projects…", "busy");
    const result = await call("projects");
    const list = Array.isArray(result?.projects) ? result.projects : [];
    const selected = project.value;
    project.replaceChildren(new Option("請選擇 Project", ""));
    for (const item of list) {
      if (typeof item?.name === "string" && item.name) project.add(new Option(item.name, item.name));
    }
    if (selected && list.some((item) => item.name === selected)) project.value = selected;
  }

  async function refreshStatus() {
    if (!organization.value.trim()) {
      setStatus("請先輸入並儲存 Organization。");
      return;
    }
    const result = await call("status");
    if (result?.authenticated) {
      setStatus("已登入 Microsoft Entra。正在載入 Azure DevOps Projects…", "success");
      await refreshProjects();
      setStatus("已登入。可選擇並儲存 Azure DevOps Project。", "success");
      cancelButton.hidden = true;
    } else if (result?.login === "pending") {
      setStatus("等待 Microsoft 帳號完成瀏覽器登入…", "busy");
      cancelButton.hidden = false;
      schedulePoll();
    } else if (result?.login === "failed") {
      setStatus("登入未完成；可重新嘗試。", "error");
      cancelButton.hidden = true;
    } else {
      setStatus("尚未登入 Microsoft Entra。");
      cancelButton.hidden = true;
    }
  }

  async function login() {
    if (!organization.value.trim()) {
      settingsStatus.textContent = "請先輸入 Organization。";
      settingsStatus.dataset.kind = "error";
      return;
    }
    popup = window.open("about:blank", "azure-devops-platform-sso");
    loginButton.disabled = true;
    try {
      await saveSettings({ organization: organization.value.trim() });
      const result = await call("login");
      if (result?.authenticated) {
        if (popup && !popup.closed) popup.close();
        await refreshStatus();
        return;
      }
      if (result?.browserUrl && popup) {
        popup.location.href = result.browserUrl;
        popup.focus();
      } else if (popup && !popup.closed) popup.close();
      setStatus("請在 Agent System 的遠端瀏覽器完成 Microsoft 登入…", "busy");
      cancelButton.hidden = false;
      schedulePoll();
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      setStatus(errorMessage(error), "error");
    } finally {
      loginButton.disabled = false;
    }
  }

  function schedulePoll() {
    if (polling || disposed) return;
    polling = true;
    let remaining = 300;
    const poll = async () => {
      if (disposed || remaining-- <= 0) {
        polling = false;
        if (!disposed) {
          setStatus("登入等待逾時；可重新嘗試。", "error");
          cancelButton.hidden = true;
        }
        return;
      }
      try {
        const result = await call("status");
        if (result?.authenticated) {
          polling = false;
          cancelButton.hidden = true;
          await refreshStatus();
          return;
        }
        if (result?.login !== "pending") {
          polling = false;
          cancelButton.hidden = true;
          setStatus("登入未完成；可重新嘗試。", "error");
          return;
        }
      } catch (error) {
        polling = false;
        setStatus(errorMessage(error), "error");
        return;
      }
      pollTimer = window.setTimeout(poll, 1_000);
    };
    pollTimer = window.setTimeout(poll, 1_000);
  }

  async function cancelLogin() {
    cancelButton.disabled = true;
    try {
      await call("cancel");
      polling = false;
      window.clearTimeout(pollTimer);
      if (popup && !popup.closed) popup.close();
      cancelButton.hidden = true;
      setStatus("登入已取消。");
    } catch (error) {
      setStatus(errorMessage(error), "error");
    } finally {
      cancelButton.disabled = false;
    }
  }

  async function logout() {
    logoutButton.disabled = true;
    try {
      await call("logout");
      polling = false;
      window.clearTimeout(pollTimer);
      setStatus("已登出 Microsoft Entra。");
      cancelButton.hidden = true;
    } catch (error) {
      setStatus(errorMessage(error), "error");
    } finally {
      logoutButton.disabled = false;
    }
  }

  root.querySelector("[data-save]").addEventListener("click", () => { void saveContext().catch((error) => { settingsStatus.textContent = errorMessage(error); settingsStatus.dataset.kind = "error"; }); });
  loginButton.addEventListener("click", () => { void login(); });
  cancelButton.addEventListener("click", () => { void cancelLogin(); });
  logoutButton.addEventListener("click", () => { void logout(); });
  refreshButton.addEventListener("click", () => { void refreshStatus().catch((error) => setStatus(errorMessage(error), "error")); });
  project.addEventListener("change", () => {
    if (project.value) void saveSettings({ organization: organization.value.trim(), project: project.value }).then(() => {
      settingsStatus.textContent = "設定已儲存。";
      settingsStatus.dataset.kind = "success";
    }).catch((error) => setStatus(errorMessage(error), "error"));
  });

  await loadSaved();
  return {
    destroy() {
      disposed = true;
      polling = false;
      window.clearTimeout(pollTimer);
      if (popup && !popup.closed) popup.close();
      container.replaceChildren();
    },
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Azure DevOps 設定操作失敗。";
}
