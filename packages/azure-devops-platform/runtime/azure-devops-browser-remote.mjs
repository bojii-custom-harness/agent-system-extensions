#!/usr/bin/env node
import { URL } from "node:url";

const authorizationUrl = process.argv[2];
const token = process.env.BROWSER_REMOTE_SESSION_TOKEN;

function fail() {
  process.exitCode = 1;
  // 終止呼叫端 Azure CLI，避免瀏覽器失敗後降級為 device-code 登入。
  try { process.kill(process.ppid, "SIGTERM"); } catch {}
}

if (!authorizationUrl || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
  fail();
} else {
  let url;
  try {
    url = new URL(authorizationUrl);
  } catch {
    fail();
  }
  if (url) {
    const redirectURI = url.searchParams.get("redirect_uri");
    let redirect;
    try {
      redirect = new URL(redirectURI || "");
    } catch {
      fail();
    }
    const validAuthority = url.protocol === "https:"
      && ["login.microsoftonline.com", "login.microsoft.com"].includes(url.hostname)
      && /\/oauth2\/v2\.0\/authorize\/?$/.test(url.pathname)
      && Boolean(url.searchParams.get("state"));
    const validRedirect = redirect?.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(redirect.hostname)
      && Boolean(redirect.port);
    if (validAuthority && validRedirect) {
      try {
        const base = "http://127.0.0.1:3001";
        const created = await fetch(`${base}/sessions/${encodeURIComponent(token)}/api/tabs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: authorizationUrl }),
          signal: AbortSignal.timeout(15_000),
        });
        const tab = await created.json().catch(() => undefined);
        if (!created.ok || typeof tab?.id !== "string") {
          fail();
        } else {
          const activated = await fetch(`${base}/sessions/${encodeURIComponent(token)}/api/tabs/${encodeURIComponent(tab.id)}/activate`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
          });
          if (!activated.ok) fail();
        }
      } catch {
        fail();
      }
    } else {
      fail();
    }
  }
}
