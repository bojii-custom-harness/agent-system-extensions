import { Buffer } from "node:buffer";
import { createDecipheriv } from "node:crypto";
import { HttpError } from "../../shared/errors.js";
import { validateProjectName } from "../opencode-projects/policy.js";
import type { ExtensionBackendService } from "./backend.js";

const CALLBACK_STATE_PREFIX = "gcp1";
const CALLBACK_STATE_TTL_MS = 10 * 60 * 1000;

export async function completeGoogleCloudPlatformOAuth(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  backend: ExtensionBackendService,
): Promise<{ headers: Record<string, string>; status: number; body: { status: "authorized" } }> {
  const completion = readCompletion(body);
  const state = completion?.state;
  const project = state ? readCallbackProject(state) : undefined;
  if (!state || !project) {
    throw completionError();
  }

  try {
    const leaseConsumed = await backend.consumeRuntimeIdentityLease("google-cloud-platform", project, state);
    if (!leaseConsumed) throw completionError();
    const result = await backend.handleGoogleCloudPlatformOAuthComplete(project, completion, headers);
    const authorized = (result?.status === undefined || (result.status >= 200 && result.status < 300))
      && isAuthorizedResult(result?.body);
    if (!authorized) throw completionError();
    return {
      body: { status: "authorized" },
      headers: { "cache-control": "no-store" },
      status: 200,
    };
  } catch {
    throw completionError();
  }
}

/**
 * Validates the package-produced opaque state envelope without retaining its
 * code or plaintext outside the completion request.
 */
export function readCallbackProject(state: string): string | undefined {
  try {
    if (state.length < 32 || state.length > 2_000) return undefined;
    const [prefix, encodedIv, encodedCiphertext, encodedTag, ...extra] = state.split(".");
    if (prefix !== CALLBACK_STATE_PREFIX || extra.length > 0 || !encodedIv || !encodedCiphertext || !encodedTag) return undefined;

    const key = readDeploymentKey();
    if (!key) return undefined;
    const iv = decodeBase64Url(encodedIv);
    const ciphertext = decodeBase64Url(encodedCiphertext);
    const tag = decodeBase64Url(encodedTag);
    if (!iv || !ciphertext || !tag || iv.length !== 12 || tag.length !== 16) return undefined;

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as unknown;
    if (!isRecord(payload) || typeof payload.p !== "string" || typeof payload.e !== "number" || typeof payload.n !== "string" || payload.s !== "project") return undefined;
    if (!Number.isFinite(payload.e) || payload.e <= Date.now() || payload.e > Date.now() + CALLBACK_STATE_TTL_MS) return undefined;
    if (payload.n.length < 16 || payload.n.length > 200) return undefined;

    return validateProjectName(payload.p);
  } catch {
    return undefined;
  }
}

function isAuthorizedResult(value: unknown): boolean {
  return isRecord(value) && value.status === "authorized";
}

function readCompletion(value: unknown): { code: string; state: string } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "code") || !Object.hasOwn(value, "state")) return undefined;
  const code = readString(value.code, 10_000);
  const state = readString(value.state, 2_000);
  return code && state ? { code, state } : undefined;
}

function completionError(): HttpError {
  return new HttpError(400, "Google Cloud authorization could not be completed.", "GCP_CALLBACK_INVALID");
}

function readString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function readDeploymentKey(): Buffer | undefined {
  const encoded = typeof process.env.EXTENSION_SECRET_KEY === "string" ? process.env.EXTENSION_SECRET_KEY.trim() : "";
  if (!encoded) return undefined;
  if (/^[0-9a-f]{64}$/i.test(encoded)) return Buffer.from(encoded, "hex");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) && !/^[A-Za-z0-9+/]{44}$/.test(encoded)) return undefined;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : undefined;
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
