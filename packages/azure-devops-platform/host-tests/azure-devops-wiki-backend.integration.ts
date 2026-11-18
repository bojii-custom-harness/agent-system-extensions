import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";

const ORGANIZATION = "contoso";
const PROJECT = "ado-project";
const WIKI_ID = "a54cad1c-3ab2-457b-8c3a-7fa9e95b481f";
const PAT = "wiki-pat-secret";
const EXTENSION_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

test("lists a bounded public Wiki projection using the configured project credential", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ headers: Headers; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ headers: new Headers(init?.headers), url: new URL(String(input)) });
      return new Response(JSON.stringify({ value: [
        { id: "wiki-1", name: "Project Wiki", type: "projectWiki", mappedPath: "/", remoteUrl: "https://dev.azure.com/contoso/project/_wiki/" },
        { id: "wiki-2", name: "Engineering", type: "codeWiki", accessToken: "must-not-escape" },
      ] }), { headers: { "content-type": "application/json" }, status: 200 });
    };

    try {
      const result = await callTool(runtime, "list-wikis", "azure_devops_list_wikis", {
        organization: ORGANIZATION,
        project: PROJECT,
      });
      assert.deepEqual(result, {
        count: 2,
        truncated: false,
        wikis: [
          { id: "wiki-1", name: "Project Wiki", type: "projectWiki", mappedPath: "/", remoteUrl: "https://dev.azure.com/contoso/project/_wiki/" },
          { id: "wiki-2", name: "Engineering", type: "codeWiki" },
        ],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url.pathname, "/contoso/ado-project/_apis/wiki/wikis");
      assert.equal(calls[0]?.url.searchParams.get("api-version"), "7.1");
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.equal(JSON.stringify(result).includes(PAT), false);
      assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("Extension UI Wiki synchronization lists wikis from the selected Organization and Project", async () => {
  await withBackend(async (runtime) => {
    let requestURL: URL | undefined;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      requestURL = new URL(String(input));
      return new Response(JSON.stringify({ value: [{ id: WIKI_ID, name: "AI_Traning_wiki", type: "projectWiki" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      const result = await runtime.handle({ request: {
        path: "list-project-wikis",
        method: "POST",
        body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
        headers: {},
      } }) as { body: { wikis: Array<{ id: string; name: string }> } };
      assert.equal(requestURL?.pathname, `/contoso/ado-project/_apis/wiki/wikis`);
      assert.equal(requestURL?.searchParams.get("api-version"), "7.1");
      assert.deepEqual(result.body.wikis, [{ id: WIKI_ID, name: "AI_Traning_wiki", type: "projectWiki" }]);
      assert.equal(JSON.stringify(result).includes(PAT), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("creates a Project Wiki through the selected Project ID and returns its synchronized Wiki ID", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: Record<string, unknown>; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ body, headers: new Headers(init?.headers), method, url });
      if (url.pathname === "/contoso/_apis/projects/ado-project") {
        return new Response(JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", name: "ado-project" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/contoso/ado-project/_apis/wiki/wikis") {
        return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      return new Response(JSON.stringify({
        id: WIKI_ID,
        name: "ado-project.wiki",
        type: "projectWiki",
        projectId: "22222222-2222-4222-8222-222222222222",
        remoteUrl: "https://dev.azure.com/contoso/ado-project/_wiki/wikis/" + WIKI_ID,
      }), { headers: { "content-type": "application/json" }, status: 201 });
    };

    try {
      const result = await runtime.handle({ request: {
        path: "create-project-wiki",
        method: "POST",
        body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
        headers: {},
      } }) as { body: { wiki: { id: string; name: string; type: string } } };
      assert.deepEqual(calls.map(({ method, url }) => `${method} ${url.pathname}`), [
        "GET /contoso/_apis/projects/ado-project",
        "GET /contoso/ado-project/_apis/wiki/wikis",
        "POST /contoso/_apis/wiki/wikis",
      ]);
      assert.equal(calls[2]?.url.searchParams.get("api-version"), "7.1");
      assert.deepEqual(calls[2]?.body, {
        name: "ado-project.wiki",
        projectId: "22222222-2222-4222-8222-222222222222",
        type: "projectWiki",
      });
      assert.equal(calls[0]?.headers.get("authorization"), `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
      assert.deepEqual(result.body.wiki, { id: WIKI_ID, name: "ado-project.wiki", type: "projectWiki", remoteUrl: `https://dev.azure.com/contoso/ado-project/_wiki/wikis/${WIKI_ID}` });
      assert.equal(JSON.stringify(result).includes(PAT), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("surfaces sanitized Azure DevOps Wiki creation error types", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/contoso/_apis/projects/ado-project") {
        return new Response(JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", name: "ado-project" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/contoso/ado-project/_apis/wiki/wikis") {
        return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      return new Response(JSON.stringify({ typeKey: "WikiBackingRepositoryProvisioningException", message: `failure ${PAT}` }), { status: 500 });
    };

    try {
      await assert.rejects(
        () => runtime.handle({ request: {
          path: "create-project-wiki",
          method: "POST",
          body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
          headers: {},
        } }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WIKI_CREATE_FAILED"), true);
          assert.equal((error as { statusCode?: number }).statusCode, 500);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal((error as { details?: { upstreamType?: string } }).details?.upstreamType, "WikiBackingRepositoryProvisioningException");
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("recovers an orphaned hidden Project Wiki repository as a Code Wiki without deleting repository data", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: Record<string, unknown>; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ body, method, url });
      if (url.pathname === "/contoso/_apis/projects/ado-project") {
        return new Response(JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", name: "ado-project" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.pathname === "/contoso/ado-project/_apis/wiki/wikis") {
        return new Response(JSON.stringify({ value: [] }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      if (url.pathname === "/contoso/_apis/wiki/wikis" && method === "POST" && body?.type === "projectWiki") {
        return new Response(JSON.stringify({ typeKey: "GitRepositoryNameAlreadyExistsException" }), { status: 500 });
      }
      if (url.pathname === "/contoso/ado-project/_apis/git/repositories") {
        assert.equal(url.searchParams.get("includeHidden"), "true");
        return new Response(JSON.stringify({ value: [{
          id: WIKI_ID,
          name: "ado-project.wiki",
          defaultBranch: "refs/heads/wikiMain",
        }] }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      return new Response(JSON.stringify({
        id: WIKI_ID,
        name: "ado-project.wiki",
        type: "codeWiki",
        remoteUrl: `https://dev.azure.com/contoso/ado-project/_wiki/wikis/${WIKI_ID}`,
      }), { headers: { "content-type": "application/json" }, status: 201 });
    };

    try {
      const result = await runtime.handle({ request: {
        path: "create-project-wiki",
        method: "POST",
        body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
        headers: {},
      } }) as { body: { wiki: { id: string; name: string; type: string }; recoveredExistingRepository: boolean } };

      assert.equal(result.body.recoveredExistingRepository, true);
      assert.deepEqual(result.body.wiki, {
        id: WIKI_ID,
        name: "ado-project.wiki",
        type: "codeWiki",
        remoteUrl: `https://dev.azure.com/contoso/ado-project/_wiki/wikis/${WIKI_ID}`,
      });
      assert.deepEqual(calls.map(({ method, url }) => `${method} ${url.pathname}`), [
        "GET /contoso/_apis/projects/ado-project",
        "GET /contoso/ado-project/_apis/wiki/wikis",
        "POST /contoso/_apis/wiki/wikis",
        "GET /contoso/ado-project/_apis/git/repositories",
        "GET /contoso/ado-project/_apis/wiki/wikis",
        "POST /contoso/_apis/wiki/wikis",
      ]);
      assert.deepEqual(calls[5]?.body, {
        type: "codeWiki",
        name: "ado-project.wiki",
        projectId: "22222222-2222-4222-8222-222222222222",
        repositoryId: WIKI_ID,
        mappedPath: "/",
        version: { version: "wikiMain" },
      });
      assert.equal(calls.some(({ method }) => method === "DELETE"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("updates a Wiki page with its fetched ETag and returns bounded page metadata", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ body?: string; headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const call = {
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      };
      calls.push(call);
      if (url.pathname.endsWith("/_apis/wiki/wikis")) {
        return new Response(JSON.stringify({ value: [{ id: WIKI_ID, name: "AI_Traning_wiki", type: "projectWiki" }] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (call.method === "GET") {
        return new Response(JSON.stringify({ path: "/Guides/Setup", content: "Old content" }), {
          headers: { "content-type": "application/json", ETag: '"old-etag"' },
          status: 200,
        });
      }
      return new Response(JSON.stringify({
        id: 12,
        path: "/Guides/Setup",
        gitItemPath: "/Guides/Setup.md",
        remoteUrl: `https://dev.azure.com/contoso/project/_wiki/wikis/${WIKI_ID}?pagePath=%2FGuides%2FSetup`,
        url: `https://dev.azure.com/contoso/project/_apis/wiki/wikis/${WIKI_ID}/pages/12`,
        content: "must-not-be-returned",
      }), { headers: { "content-type": "application/json", ETag: '"new-etag"' }, status: 200 });
    };

    try {
      const markdown = "# Setup\n\nNew content.\n";
      const result = await callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
        organization: ORGANIZATION,
        project: PROJECT,
        wikiIdentifier: WIKI_ID,
        path: "/Guides/Setup",
        content: markdown,
        comment: "Update setup guide",
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.method, "GET");
      assert.equal(calls[0]?.url.searchParams.get("path"), "/Guides/Setup");
      assert.equal(calls[0]?.url.searchParams.get("includeContent"), "true");
      assert.equal(calls[0]?.url.pathname.includes(WIKI_ID), true);
      assert.equal(calls[1]?.method, "PUT");
      assert.equal(calls[1]?.url.searchParams.get("path"), "/Guides/Setup");
      assert.equal(calls[1]?.url.searchParams.get("comment"), "Update setup guide");
      assert.equal(calls[1]?.headers.get("if-match"), '"old-etag"');
      assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), { content: markdown });
      assert.deepEqual(result, {
        created: false,
        wikiIdentifier: WIKI_ID,
        path: "/Guides/Setup",
        page: {
          id: 12,
          path: "/Guides/Setup",
          gitItemPath: "/Guides/Setup.md",
          url: `https://dev.azure.com/contoso/project/_apis/wiki/wikis/${WIKI_ID}/pages/12`,
          remoteUrl: `https://dev.azure.com/contoso/project/_wiki/wikis/${WIKI_ID}?pagePath=%2FGuides%2FSetup`,
        },
        etag: '"new-etag"',
      });
      assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
      assert.equal(JSON.stringify(result).includes(PAT), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("creates a missing Wiki page without an If-Match header", async () => {
  await withBackend(async (runtime) => {
    const calls: Array<{ headers: Headers; method: string; url: URL }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({ headers: new Headers(init?.headers), method, url: new URL(String(input)) });
      if (method === "GET") return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ id: 3, path: "/New-Page" }), {
        headers: { "content-type": "application/json", ETag: '"created-etag"' },
        status: 201,
      });
    };

    try {
      const result = await callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
        organization: ORGANIZATION,
        project: PROJECT,
        wikiIdentifier: WIKI_ID,
        path: "New-Page",
        content: "# New page\n",
      });
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.url.searchParams.get("path"), "/New-Page");
      assert.equal(calls[1]?.url.searchParams.get("path"), "/New-Page");
      assert.equal(calls[1]?.method, "PUT");
      assert.equal(calls[1]?.headers.has("if-match"), false);
      assert.equal((result as { created: boolean }).created, true);
      assert.equal((result as { path: string }).path, "/New-Page");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("creates missing ancestor pages and accepts a backing Git item path ending in .md", async () => {
  await withBackend(async (runtime) => {
    const pages = new Map<string, string>();
    const calls: Array<{ content?: string; method: string; path?: string; wikiID?: string }> = [];
    let transientAncestor404 = true;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const endpoint = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = endpoint.searchParams.get("path") ?? undefined;
      const isWikiList = endpoint.pathname.endsWith("/_apis/wiki/wikis");
      const wikiID = endpoint.pathname.includes("/pages") ? endpoint.pathname.split("/").at(-2) : undefined;
      const content = typeof init?.body === "string"
        ? (JSON.parse(init.body) as { content?: string }).content
        : undefined;
      calls.push({ content, method, path, wikiID });

      if (isWikiList) {
        return new Response(JSON.stringify({ value: [{ id: WIKI_ID, name: "AI_Traning_wiki", type: "projectWiki" }] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }

      if (method === "GET") {
        return pages.has(path ?? "")
          ? new Response(JSON.stringify({ path, content: pages.get(path ?? "") }), {
            headers: { "content-type": "application/json", ETag: '"existing-etag"' },
            status: 200,
          })
          : new Response(JSON.stringify({ typeKey: "WikiPageNotFoundException" }), { status: 404 });
      }

      if (path === "/PRD" && method === "PUT" && transientAncestor404) {
        transientAncestor404 = false;
        return new Response(JSON.stringify({
          typeKey: "WikiAncestorPageNotFoundException",
          message: "A transient ancestor page visibility delay.",
        }), { status: 404 });
      }

      const segments = (path ?? "").split("/").filter(Boolean);
      const missingAncestor = segments.slice(0, -1).some((_, index) => {
        const ancestor = `/${segments.slice(0, index + 1).join("/")}`;
        return !pages.has(ancestor);
      });
      if (missingAncestor) {
        return new Response(JSON.stringify({
          typeKey: "WikiAncestorPageNotFoundException",
          message: `One or more ancestor pages of '${path}' does not exist.`,
        }), { status: 404 });
      }

      pages.set(path ?? "", content ?? "");
      return new Response(JSON.stringify({
        id: pages.size,
        path,
        gitItemPath: `${path}.md`,
      }), {
        headers: { "content-type": "application/json", ETag: `"etag-${pages.size}"` },
        status: 201,
      });
    };

    try {
      const result = await callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
        organization: ORGANIZATION,
        project: PROJECT,
        wikiIdentifier: "AI_Traning_wiki",
        path: "/PRD/xxx/spec.md",
        content: "# Product requirements\n",
      }) as {
        created: boolean;
        createdAncestors: string[];
        wikiIdentifier: string;
        wikiName: string;
        page: { gitItemPath: string; path: string };
        path: string;
      };

      assert.equal(result.created, true);
      assert.equal(result.path, "/PRD/xxx/spec");
      assert.deepEqual(result.createdAncestors, ["/PRD", "/PRD/xxx"]);
      assert.equal(result.wikiIdentifier, WIKI_ID);
      assert.equal(result.wikiName, "AI_Traning_wiki");
      assert.deepEqual(result.page, { id: 3, path: "/PRD/xxx/spec", gitItemPath: "/PRD/xxx/spec.md" });
      assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
        "GET undefined",
        "GET /PRD/xxx/spec",
        "GET /PRD",
        "PUT /PRD",
        "GET /PRD",
        "PUT /PRD",
        "GET /PRD/xxx",
        "PUT /PRD/xxx",
        "GET /PRD/xxx/spec",
        "PUT /PRD/xxx/spec",
      ]);
      assert.equal(calls.every((call) => call.wikiID === undefined || call.wikiID === WIKI_ID), true);
      assert.equal(calls[3]?.content, "");
      assert.equal(calls[7]?.content, "");
      assert.equal(pages.get("/PRD/xxx/spec"), "# Product requirements\n");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("does not write when an existing page has no ETag", async () => {
  await withBackend(async (runtime) => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ path: "/Guides/Setup" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
          organization: ORGANIZATION,
          project: PROJECT,
          wikiIdentifier: WIKI_ID,
          path: "/Guides/Setup",
          content: "# Setup\n",
        }),
        (error: unknown) => isCodedError(error, "ADO_WIKI_ETAG_MISSING"),
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("surfaces a stale ETag conflict without retrying the page write", async () => {
  await withBackend(async (runtime) => {
    const methods: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") return new Response(JSON.stringify({ path: "/Guides/Setup" }), {
        headers: { "content-type": "application/json", ETag: '"stale-etag"' },
        status: 200,
      });
      return new Response(JSON.stringify({ message: "Version conflict" }), { status: 412 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
          organization: ORGANIZATION,
          project: PROJECT,
          wikiIdentifier: WIKI_ID,
          path: "/Guides/Setup",
          content: "# Conflicting update\n",
        }),
        (error: unknown) => isCodedError(error, "ADO_WIKI_PAGE_WRITE_FAILED"),
      );
      assert.deepEqual(methods, ["GET", "PUT"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("surfaces Wiki permission failures without exposing the PAT", async () => {
  await withBackend(async (runtime) => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: `wiki read denied ${PAT}` }), { status: 403 });

    try {
      await assert.rejects(
        () => callTool(runtime, "list-wikis", "azure_devops_list_wikis", {
          organization: ORGANIZATION,
          project: PROJECT,
        }),
        (error: unknown) => {
          assert.equal(isCodedError(error, "ADO_WIKI_LIST_FAILED"), true);
          assert.equal((error as { statusCode?: number }).statusCode, 403);
          assert.equal((error as Error).message.includes(PAT), false);
          assert.equal(JSON.stringify((error as { details?: unknown }).details).includes(PAT), false);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("fails safely when the Wiki identifier does not exist", async () => {
  await withBackend(async (runtime) => {
    const methods: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ typeKey: "GitRepositoryNotFoundException" }), { status: 404 });
    };

    try {
      await assert.rejects(
        () => callTool(runtime, "write-wiki-page", "azure_devops_write_wiki_page", {
          organization: ORGANIZATION,
          project: PROJECT,
          wikiIdentifier: "missing-wiki",
          path: "/Guides/Setup",
          content: "# Setup\n",
        }),
        (error: unknown) => isCodedError(error, "ADO_WIKI_NOT_FOUND_OR_UNAVAILABLE"),
      );
      assert.deepEqual(methods, ["GET"]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

async function withBackend(run: (runtime: { handle: (input: unknown) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ado-wiki-backend-"));
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  process.env.EXTENSION_SECRET_KEY = EXTENSION_SECRET_KEY;
  process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
  try {
    const runtime = await activate() as { handle: (input: unknown) => Promise<unknown> };
    await runtime.handle({ request: {
      path: "store-credential",
      method: "POST",
      body: { organization: ORGANIZATION, project: PROJECT, token: PAT },
      headers: {},
    } });
    await run(runtime);
  } finally {
    if (previousSecret === undefined) delete process.env.EXTENSION_SECRET_KEY;
    else process.env.EXTENSION_SECRET_KEY = previousSecret;
    if (previousStorePath === undefined) delete process.env.ADO_CREDENTIAL_STORE_PATH;
    else process.env.ADO_CREDENTIAL_STORE_PATH = previousStorePath;
    await rm(root, { force: true, recursive: true });
  }
}

async function callTool(
  runtime: { handle: (input: unknown) => Promise<unknown> },
  path: "list-wikis" | "write-wiki-page",
  tool: "azure_devops_list_wikis" | "azure_devops_write_wiki_page",
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const response = await runtime.handle({ request: {
    path,
    method: "POST",
    body: {},
    headers: { "x-extension-secret-key": EXTENSION_SECRET_KEY },
    extensionContext: {
      azureDevOps: {
        effectiveContext: {
          organization: ORGANIZATION,
          adoProject: PROJECT,
          parameterPolicy: {
            tools: {
              [tool]: { fields: { project: { mode: "fixed", value: PROJECT } } },
            },
          },
        },
        resolvedToolCall: { tool, parameters },
      },
    },
  } });
  return (response as { body: unknown }).body;
}

function isCodedError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
