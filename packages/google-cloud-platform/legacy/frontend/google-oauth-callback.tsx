import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { completeGoogleCloudPlatformOAuth } from "@/shared/api/platformExtensions"

const CALLBACK_PATH = "/oauth/google/callback"
const COMPLETION_MESSAGE = "agent-system:google-cloud-platform-oauth-complete"

type Completion = {
  code?: string
  state?: string
}

export function GoogleOAuthCallbackRoute({ code, state }: Completion) {
  const completion = useRef<Completion>({ code, state })
  const started = useRef(false)
  const [status, setStatus] = useState<"complete" | "failed" | "working">("working")

  useLayoutEffect(() => {
    window.history.replaceState(null, "", CALLBACK_PATH)
  }, [])

  useEffect(() => {
    if (started.current) return

    let controller: AbortController | undefined
    const timer = window.setTimeout(() => {
      if (started.current) return
      started.current = true

      const input = completion.current
      completion.current = {}
      if (!input.code || !input.state) {
        setStatus("failed")
        notifyOpener("failed")
        return
      }

      controller = new AbortController()
      void completeGoogleCloudPlatformOAuth({ code: input.code, state: input.state }, { signal: controller.signal })
        .then(() => {
          setStatus("complete")
          notifyOpener("authorized")
        })
        .catch(() => {
          if (controller?.signal.aborted) return
          setStatus("failed")
          notifyOpener("failed")
        })
    }, 0)

    return () => {
      window.clearTimeout(timer)
      controller?.abort()
    }
  }, [])

  const message = status === "working"
    ? "Completing Google Cloud authorization..."
    : status === "complete"
      ? "Google Cloud authorization completed. You can return to the extension."
      : "Google Cloud authorization could not be completed. Return to the extension and reconnect."

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section aria-labelledby="google-oauth-callback-title" className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold" id="google-oauth-callback-title">Google Cloud Platform</h1>
        <p className="mt-3 text-sm text-muted-foreground" role="status">{message}</p>
        {status !== "working" ? <a className="mt-5 inline-block text-sm font-medium text-primary underline" href="/extensions/google-cloud-platform">Return to the extension</a> : null}
      </section>
    </main>
  )
}

function notifyOpener(status: "authorized" | "failed") {
  if (!window.opener || window.opener.closed) return
  window.opener.postMessage({ status, type: COMPLETION_MESSAGE }, window.location.origin)
  window.setTimeout(() => window.close(), 0)
}
