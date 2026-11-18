import { Plugin } from "@opencode/plugin";
import { currentOpenCodeProject } from "./agent/context.ts";

const INPUT = {
  type: "object",
  properties: {
    arguments: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 8192 },
      minItems: 1,
      maxItems: 100,
      description: "Arguments after `az devops`, for example [\"project\", \"list\"]. Pass an argv array, not a shell command string.",
    },
  },
  required: ["arguments"],
  additionalProperties: false,
};

export function createAzureDevOpsToolDefinitions(pluginInput: unknown = {}) {
  return {
    azure_devops_cli: {
      description: "Run an official Azure DevOps CLI command. Only the `az devops` command group is available; shell syntax and other Azure CLI command groups are not accepted. Organization and Project come from the current Extension settings. `invoke` is allowed and may access any Azure DevOps resource that the signed-in account is authorized to access, including resources outside the selected Project.",
      input: INPUT,
      async execute(args: unknown) {
        if (!isRecord(args)) throw new Error("Azure DevOps CLI arguments must be an object.");
        const project = currentOpenCodeProject(pluginInput);
        const result = await callBackend(project, args.arguments);
        return {
          content: JSON.stringify(result, null, 2),
          metadata: { title: "Azure DevOps CLI" },
        };
      },
    },
  };
}

export async function callBackend(project: string, args: unknown) {
  const baseURL = (process.env.AGENT_SYSTEM_BFF_BASE_URL || "http://backend:8000").replace(/\/+$/, "");
  const endpoint = new URL("/bff/extensions/azure-devops-platform/backend/run-cli", baseURL);
  endpoint.searchParams.set("project", project);
  endpoint.searchParams.set("scope", "project");
  const extensionSecret = process.env.EXTENSION_SECRET_KEY?.trim();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-agent-system-workspace": project,
        ...(extensionSecret ? { "x-extension-secret-key": extensionSecret } : {}),
      },
      body: JSON.stringify({ arguments: args }),
      signal: AbortSignal.timeout(160_000),
    });
  } catch {
    throw new Error("Azure DevOps CLI backend is unavailable.");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
    const message = typeof error.message === "string" ? error.message : "Azure DevOps CLI command failed.";
    throw new Error(message.slice(0, 2_000));
  }
  if (!isRecord(payload) || !Number.isInteger(payload.exitCode) || typeof payload.output !== "string") {
    throw new Error("Azure DevOps CLI backend returned an invalid result.");
  }
  return payload;
}

const AzureDevOpsPlatformPlugin = Plugin.define({
  id: "azure-devops-platform",
  async setup(context) {
    const pluginInput = {
      directory: context.location.directory,
      project: context.location.directory.split(/[\\/]/).filter(Boolean).at(-1),
    };
    const definitions = createAzureDevOpsToolDefinitions(pluginInput);
    await context.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(definitions)) {
        editor.add({
          name,
          ...definition,
          options: { codemode: false },
        });
      }
    });
  },
});

export default AzureDevOpsPlatformPlugin;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
