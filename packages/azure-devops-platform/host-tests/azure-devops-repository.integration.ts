import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createDefaultAzureDevOpsParameterPolicy,
} from "../policy/index.ts";
import { activate } from "../extension-packages/azure-devops-platform/backend/entry.js";

const ORGANIZATION = "contoso";
const ADO_PROJECT = "ado-project";
const ADO_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const CANONICAL_REMOTE = "https://dev.azure.com/contoso/ado-project/_git/new-repository";
const ORGANIZATION_QUALIFIED_REMOTE = "https://contoso@dev.azure.com/contoso/ado-project/_git/new-repository";
const PAT = "pat-secret-value";
const EXTENSION_SECRET = "extension-secret-value";

test("resolves the ADO project ID before creating a repository and returns verified metadata", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("create-repository", {
      tool: "azure_devops_create_repository",
      agentInput: { repositoryName: "new-repository" },
    }));

    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
      { method: "GET", url: `https://dev.azure.com/${ORGANIZATION}/_apis/projects/${ADO_PROJECT}?api-version=7.1` },
      { method: "POST", url: `https://dev.azure.com/${ORGANIZATION}/_apis/git/repositories?api-version=7.1` },
    ]);
    assert.deepEqual(requests[1]?.body, {
      name: "new-repository",
      project: { id: ADO_PROJECT_ID },
    });
    assert.equal(requests[1]?.body?.description, undefined);
    assert.equal(requests[1]?.body?.defaultBranch, undefined);
    assert.deepEqual(result.body.repository, {
      id: REPOSITORY_ID,
      name: "new-repository",
      project: { id: ADO_PROJECT_ID, name: ADO_PROJECT },
      remoteUrl: CANONICAL_REMOTE,
      repositoryReference: `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`,
    });
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
  }, async () => response(200, repositoryPayload()));
});

test("keeps existing repository creation metadata behavior outside repository listing", async () => {
  const repositoryName = "repository\u0000name";
  const remoteUrl = "https://dev.azure.com/contoso/ado-project/_git/repository%00name";
  await withRepositoryBackend(async ({ runtime, context, requests }) => {
    const result = await runtime.handle(context("create-repository", {
      tool: "azure_devops_create_repository",
      agentInput: { repositoryName: "new-repository" },
    }));

    assert.equal(result.body.repository.name, repositoryName);
    assert.equal(result.body.repository.remoteUrl, remoteUrl);
  }, async () => response(200, repositoryPayload({ name: repositoryName, remoteUrl })));
});

test("lists project repositories through Azure DevOps REST 7.1 and returns only safe canonical metadata", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("list-repositories", {
      tool: "azure_devops_list_repositories",
      agentInput: {},
    }, {
      organization: ORGANIZATION,
      project: ADO_PROJECT,
    }, {
      organization: "derived",
      project: "fixed",
    }));

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, `https://dev.azure.com/${ORGANIZATION}/_apis/projects/${ADO_PROJECT}?api-version=7.1`);
    assert.equal(requests[1]?.method, "GET");
    assert.equal(requests[1]?.url, `https://dev.azure.com/${ORGANIZATION}/${ADO_PROJECT}/_apis/git/repositories?api-version=7.1`);
    assert.equal(requests[1]?.authorization, `Basic ${Buffer.from(`:${PAT}`, "utf8").toString("base64")}`);
    assert.equal(requests[1]?.url.includes("includeHidden"), false);
    assert.equal(requests[1]?.url.includes("includeAllUrls"), false);
    assert.deepEqual(result.body, {
      count: 2,
      repositories: [
        { id: REPOSITORY_ID, name: "new-repository", remoteUrl: CANONICAL_REMOTE },
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "second-repository",
          remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/second-repository",
        },
      ],
    });
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(JSON.stringify(result).includes(EXTENSION_SECRET), false);
    assert.equal(JSON.stringify(result).includes("repositoryReference"), false);
    assert.deepEqual(Object.keys(result.body), ["count", "repositories"]);
    for (const repository of result.body.repositories) {
      assert.deepEqual(Object.keys(repository), ["id", "name", "remoteUrl"]);
    }
  }, async () => response(200, {
    value: [
      {
        ...repositoryPayload(),
        remoteUrls: ["https://example.invalid/alternate.git"],
        url: "https://dev.azure.com/contoso/_apis/git/repositories/raw-metadata",
      },
      {
        ...repositoryPayload({
          id: "33333333-3333-4333-8333-333333333333",
          name: "second-repository",
          remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/second-repository",
        }),
        size: 123456,
      },
    ],
  }));
});

test("accepts case-insensitive REST Project names and canonicalizes URLs with the effective Project context", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("list-repositories", {
      tool: "azure_devops_list_repositories",
      agentInput: {},
    }, {
      organization: ORGANIZATION,
      project: ADO_PROJECT,
    }, {
      organization: "derived",
      project: "fixed",
    }));

    assert.equal(requests[1]?.url, `https://dev.azure.com/${ORGANIZATION}/${ADO_PROJECT}/_apis/git/repositories?api-version=7.1`);
    assert.deepEqual(result.body, {
      count: 1,
      repositories: [{ id: REPOSITORY_ID, name: "new-repository", remoteUrl: CANONICAL_REMOTE }],
    });
  }, async () => response(200, {
    value: [repositoryPayload({
      project: { id: ADO_PROJECT_ID, name: "ADO-PROJECT" },
      remoteUrl: "https://dev.azure.com/contoso/ADO-PROJECT/_git/new-repository",
    })],
  }));
});

test("returns a consistent empty repository list", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("list-repositories", {
      tool: "azure_devops_list_repositories",
      agentInput: {},
    }, {
      organization: ORGANIZATION,
      project: ADO_PROJECT,
    }, {
      organization: "derived",
      project: "fixed",
    }));

    assert.equal(requests.length, 2);
    assert.deepEqual(result.body, { count: 0, repositories: [] });
  }, async () => response(200, { value: [] }));
});

test("rejects any malformed or cross-project repository instead of returning a partial list", async () => {
  const invalidRepositories = [
    repositoryPayload({ project: { id: ADO_PROJECT_ID, name: "other-project" } }),
    repositoryPayload({ project: { id: "33333333-3333-4333-8333-333333333333", name: ADO_PROJECT } }),
    repositoryPayload({ id: "not-a-uuid" }),
    repositoryPayload({ name: "" }),
    repositoryPayload({ name: "invalid\u0000repository-name" }),
    repositoryPayload({ remoteUrl: "http://dev.azure.com/contoso/ado-project/_git/new-repository" }),
    repositoryPayload({ remoteUrl: "https://dev.azure.com/contoso/other-project/_git/new-repository" }),
    repositoryPayload({ remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository" }),
  ];

  for (const invalidRepository of invalidRepositories) {
    await withRepositoryBackend(async ({ runtime, context }) => {
      await assert.rejects(
        runtime.handle(context("list-repositories", {
          tool: "azure_devops_list_repositories",
          agentInput: {},
        }, {
          organization: ORGANIZATION,
          project: ADO_PROJECT,
        }, {
          organization: "derived",
          project: "fixed",
        })),
        (error: unknown) => {
          assert.match(errorCode(error) ?? "", /AZURE_DEVOPS_(PROJECT_MISMATCH|REPOSITORY_METADATA_INVALID)/);
          assert.equal(errorMessage(error).includes(PAT), false);
          assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
          return true;
        },
      );
    }, async () => response(200, { value: [repositoryPayload(), invalidRepository] }));
  }
});

test("returns a bounded secret-safe diagnostic when the repository-list API rejects the request", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("list-repositories", {
        tool: "azure_devops_list_repositories",
        agentInput: {},
      }, {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
      }, {
        organization: "derived",
        project: "fixed",
      })),
      (error: unknown) => {
        assert.equal(errorCode(error), "ADO_REPOSITORY_LIST_FAILED");
        assert.equal((error as { statusCode?: number }).statusCode, 403);
        assert.equal((error as { details?: Record<string, unknown> }).details?.upstreamStatus, 403);
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
  }, async () => response(403, { message: `Authorization: Bearer ${PAT}; ${EXTENSION_SECRET}` }));
});

test("rejects a malformed repository-list response without returning an empty success", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("list-repositories", {
        tool: "azure_devops_list_repositories",
        agentInput: {},
      }, {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
      }, {
        organization: "derived",
        project: "fixed",
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_LIST_RESPONSE_INVALID",
    );
  }, async () => response(200, { count: 0 }));
});

test("preserves the bounded upstream status when the selected ADO Project cannot be verified", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    await assert.rejects(
      runtime.handle(context("list-repositories", {
        tool: "azure_devops_list_repositories",
        agentInput: {},
      }, {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
      }, {
        organization: "derived",
        project: "fixed",
      })),
      (error: unknown) => {
        assert.equal(errorCode(error), "ADO_REPOSITORY_LIST_FAILED");
        assert.equal((error as { statusCode?: number }).statusCode, 403);
        assert.deepEqual((error as { details?: Record<string, unknown> }).details, { upstreamStatus: 403 });
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, `https://dev.azure.com/${ORGANIZATION}/_apis/projects/${ADO_PROJECT}?api-version=7.1`);
  }, async () => response(200, { value: [] }), async () => response(403, {
    message: `Authorization: Bearer ${PAT}; ${EXTENSION_SECRET}`,
  }));
});

test("preserves sanitized Azure DevOps HTTP and inner error details for failed repository creation", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      () => runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: "new-repository" },
      })),
      (error: unknown) => {
        const details = error && typeof error === "object" && "details" in error
          ? error.details as Record<string, unknown>
          : {};
        assert.equal(errorCode(error), "ADO_REPOSITORY_CREATE_FAILED");
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.equal(details.upstreamStatus, 400);
        assert.equal(details.upstreamCode, "ProjectReferenceRequired");
        assert.equal(details.upstreamInnerMessage, "Project ID is required.");
        assert.match(errorMessage(error), /Project ID is required/);
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
  }, async (url) => url.includes("/_apis/git/repositories?")
    ? response(400, {
      typeKey: "ProjectReferenceRequired",
      message: `Azure DevOps rejected the request. Authorization: Bearer ${PAT}`,
      innerException: { message: "Project ID is required." },
    })
    : response(200, projectPayload()));
});

test("normalizes the organization-qualified HTTPS clone URL in repository metadata", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    const result = await runtime.handle(context("create-repository", {
      tool: "azure_devops_create_repository",
      agentInput: { repositoryName: "new-repository" },
    }));

    assert.equal(result.body.repository.remoteUrl, CANONICAL_REMOTE);
    assert.equal(JSON.stringify(result.body).includes("contoso@"), false);
  }, async () => response(200, repositoryPayload({ remoteUrl: ORGANIZATION_QUALIFIED_REMOTE })));
});

test("normalizes an older Visual Studio collection URL in repository metadata", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    const result = await runtime.handle(context("create-repository", {
      tool: "azure_devops_create_repository",
      agentInput: { repositoryName: "new-repository" },
    }));

    assert.equal(result.body.repository.remoteUrl, CANONICAL_REMOTE);
  }, async () => response(200, repositoryPayload({
    remoteUrl: "https://contoso.visualstudio.com/DefaultCollection/ado-project/_git/new-repository",
  })));
});

test("maps an existing repository to a bounded conflict without reusing its metadata", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: "new-repository" },
      })),
      (error: unknown) => {
        assert.equal(errorCode(error), "AZURE_DEVOPS_REPOSITORY_CONFLICT");
        assert.equal(errorMessage(error).includes(PAT), false);
        assert.equal(errorMessage(error).includes(EXTENSION_SECRET), false);
        return true;
      },
    );
  }, async () => response(409, { message: `Authorization: Bearer ${PAT}` }));
});

test("rejects repository metadata from another ADO project", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: "new-repository" },
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_PROJECT_MISMATCH",
    );
  }, async () => response(200, repositoryPayload({ project: { id: ADO_PROJECT_ID, name: "other-project" } })));
});

test("rejects malformed or non-Azure DevOps canonical repository metadata", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: "new-repository" },
      })),
      (error: unknown) => {
        assert.equal(errorCode(error), "AZURE_DEVOPS_REPOSITORY_METADATA_INVALID");
        assert.equal(errorMessage(error).includes(PAT), false);
        return true;
      },
    );
  }, async () => response(200, repositoryPayload({ remoteUrl: "https://attacker.example/repository.git" })));
});

test("rejects repository metadata whose remote URL identifies another repository", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: "new-repository" },
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_METADATA_INVALID",
    );
  }, async () => response(200, repositoryPayload({ remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository" })));
});

test("looks up a verified repository reference through canonical Azure DevOps metadata", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("lookup-repository", {
      tool: "azure_devops_configure_remote",
      agentInput: {
        repositoryPath: "repository/solo-block-stacker",
        repositoryReference: `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`,
      },
    }, {
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      repositoryPath: "repository/solo-block-stacker",
      repositoryReference: `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`,
      remoteName: "deploy",
      updateExisting: true,
    }));

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.url, `https://dev.azure.com/${ORGANIZATION}/${ADO_PROJECT}/_apis/git/repositories/${REPOSITORY_ID}?api-version=7.1`);
    assert.equal(result.body.repository.repositoryReference, `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`);
    assert.deepEqual(result.body.operationPlan, {
      parameters: {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
        repositoryPath: "repository/solo-block-stacker",
        repositoryReference: `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`,
        remoteName: "deploy",
        updateExisting: true,
      },
      tool: "azure_devops_configure_remote",
    });
  }, async () => response(200, repositoryPayload()));
});

test("verifies the observed push remote against Azure DevOps repository identity before brokering a credential", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("push-credential", {
      observedRemoteUrl: CANONICAL_REMOTE,
      tool: "azure_devops_push",
      agentInput: { branch: "main", repositoryPath: "repository/new-repository", setUpstream: true },
    }));

    assert.equal(result.body.organization, ORGANIZATION);
    assert.equal(result.body.project, ADO_PROJECT);
    assert.equal(result.body.remoteName, "origin");
    assert.equal(result.body.branch, "main");
    assert.equal(result.body.setUpstream, true);
    assert.equal(result.body.remoteUrl, CANONICAL_REMOTE);
    assert.equal(result.body.token, PAT);
    assert.equal(requests.filter((request) => request.url.includes("/_apis/git/repositories/")).length, 1);
  }, async () => response(200, repositoryPayload()));
});

test("normalizes an organization-qualified observed remote before verifying and brokering push", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const result = await runtime.handle(context("push-credential", {
      observedRemoteUrl: ORGANIZATION_QUALIFIED_REMOTE,
      tool: "azure_devops_push",
      agentInput: { branch: "main", repositoryPath: "repository/new-repository", setUpstream: true },
    }));

    assert.equal(result.body.remoteUrl, CANONICAL_REMOTE);
    assert.equal(requests.filter((request) => request.url.includes("/_apis/git/repositories/")).length, 1);
  }, async () => response(200, repositoryPayload()));
});

test("returns a sanitized push preflight plan without brokering a credential", async () => {
  await withRepositoryBackend(async ({ runtime, context, requests }) => {
    const result = await runtime.handle(context("push-plan", {
      tool: "azure_devops_push",
      agentInput: { branch: "main", remoteName: "origin", repositoryPath: "repository/new-repository" },
    }, {
      branch: "main",
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      repositoryPath: "repository/new-repository",
      remoteName: "deploy",
      setUpstream: false,
    }));

    assert.deepEqual(result.body, {
      operationPlan: {
          parameters: {
            branch: "main",
            organization: ORGANIZATION,
            project: ADO_PROJECT,
            repositoryPath: "repository/new-repository",
            remoteName: "deploy",
            setUpstream: false,
        },
        sources: {},
        tool: "azure_devops_push",
      },
    });
    assert.equal(JSON.stringify(result).includes(PAT), false);
    assert.equal(requests.some((request) => request.url.includes("/_apis/git/repositories/")), false);
  }, async () => response(200, repositoryPayload()));
});

test("returns a sanitized pull plan and verifies the selected remote before brokering a credential", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const agentInput = { branch: "feature/pull", repositoryPath: "repository/new-repository" };
    const resolvedParameters = {
      branch: "feature/pull",
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      remoteName: "origin",
      repositoryPath: "repository/new-repository",
    };
    const resolvedSources = {
      branch: "agent",
      organization: "derived",
      project: "fixed",
      remoteName: "fixed",
      repositoryPath: "agent",
    };
    const plan = await runtime.handle(context("pull-plan", {
      tool: "azure_devops_git_pull",
      agentInput,
    }, resolvedParameters, resolvedSources));

    assert.deepEqual(plan.body.operationPlan, {
      parameters: resolvedParameters,
      sources: resolvedSources,
      tool: "azure_devops_git_pull",
    });
    assert.equal(JSON.stringify(plan).includes(PAT), false);
    assert.equal(requests.length, 0);

    const credential = await runtime.handle(context("pull-credential", {
      observedRemoteUrl: CANONICAL_REMOTE,
      tool: "azure_devops_git_pull",
      agentInput,
    }, resolvedParameters, resolvedSources));

    assert.deepEqual(credential.body, {
      branch: "feature/pull",
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      remoteName: "origin",
      remoteUrl: CANONICAL_REMOTE,
      token: PAT,
    });
    assert.equal(requests.filter((request) => request.url.includes("/_apis/git/repositories/")).length, 1);
  }, async () => response(200, repositoryPayload()));
});

test("refuses to broker a pull credential for a different Azure DevOps repository", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("pull-credential", {
        observedRemoteUrl: CANONICAL_REMOTE,
        tool: "azure_devops_git_pull",
        agentInput: { repositoryPath: "repository/new-repository" },
      }, {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
        remoteName: "origin",
        repositoryPath: "repository/new-repository",
      }, {
        organization: "derived",
        project: "fixed",
        remoteName: "fixed",
        repositoryPath: "agent",
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_REMOTE_MISMATCH",
    );
  }, async () => response(200, repositoryPayload({ remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository" })));
});

test("push credential responses use the resolved remote plan rather than raw request fields", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    const result = await runtime.handle(context("push-credential", {
      observedRemoteUrl: CANONICAL_REMOTE,
      tool: "azure_devops_push",
      agentInput: { branch: "main", remoteName: "origin", repositoryPath: "repository/new-repository" },
    }, {
      branch: "main",
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      remoteName: "deploy",
      setUpstream: false,
    }));

    assert.equal(result.body.remoteName, "deploy");
    assert.equal(result.body.token, PAT);
  }, async () => response(200, repositoryPayload()));
});

test("rejects a push when Azure DevOps returns a different repository identity", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      runtime.handle(context("push-credential", {
        observedRemoteUrl: CANONICAL_REMOTE,
        tool: "azure_devops_push",
        agentInput: { branch: "main", repositoryPath: "repository/new-repository" },
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_REMOTE_MISMATCH",
    );
  }, async () => response(200, repositoryPayload({ remoteUrl: "https://dev.azure.com/contoso/ado-project/_git/other-repository" })));
});

test("looks up clone metadata by repository name and returns a broker credential only through the clone broker path", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    const rawCloneInput = { repositoryName: "new-repository", branch: "raw-branch", depth: 1, destination: "raw-checkout" };
    const lookup = await runtime.handle(context("clone-repository", {
      tool: "azure_devops_clone_repository",
      agentInput: rawCloneInput,
    }, {
      branch: "resolved-branch",
      depth: 7,
      destination: "resolved-checkout",
      organization: ORGANIZATION,
      project: ADO_PROJECT,
      repositoryName: "new-repository",
    }));

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.url, `https://dev.azure.com/${ORGANIZATION}/${ADO_PROJECT}/_apis/git/repositories/new-repository?api-version=7.1`);
    assert.deepEqual(lookup.body.repository, {
      id: REPOSITORY_ID,
      name: "new-repository",
      project: { id: ADO_PROJECT_ID, name: ADO_PROJECT },
      remoteUrl: CANONICAL_REMOTE,
      repositoryReference: `azure-devops://${ORGANIZATION}/${ADO_PROJECT}/${REPOSITORY_ID}`,
    });
    assert.deepEqual(lookup.body.operationPlan, {
      parameters: {
        branch: "resolved-branch",
        depth: 7,
        destination: "resolved-checkout",
        organization: ORGANIZATION,
        project: ADO_PROJECT,
        repositoryName: "new-repository",
      },
      tool: "azure_devops_clone_repository",
    });

    const credential = await runtime.handle(context("get-git-credential", {
      tool: "azure_devops_clone_repository",
      agentInput: rawCloneInput,
    }));
    assert.deepEqual(credential.body, {
      credential: PAT,
      organization: ORGANIZATION,
      project: ADO_PROJECT,
    });
    assert.equal(JSON.stringify(lookup).includes(PAT), false);
  }, async () => response(200, repositoryPayload()));
});

test("isolates project credentials for direct Extension REST operations", async () => {
  const projectAID = "22222222-2222-4222-8222-222222222221";
  const projectBID = "22222222-2222-4222-8222-222222222222";
  const projectIDs = new Map([["project-a", projectAID], ["project-b", projectBID]]);
  await withRepositoryBackend(async ({ runtime, context, requests }) => {
    const first = await runtime.handle(context("store-credential", {
      organization: ORGANIZATION,
      project: "project-a",
      token: "pat-project-a",
    }));
    const second = await runtime.handle(context("store-credential", {
      organization: ORGANIZATION,
      project: "project-b",
      token: "pat-project-b",
    }));

    assert.equal(JSON.stringify(first).includes("pat-project-a"), false);
    assert.equal(JSON.stringify(second).includes("pat-project-b"), false);
    for (const project of ["project-a", "project-b"]) {
      await runtime.handle(context("create-repository", {
        tool: "azure_devops_create_repository",
        agentInput: { repositoryName: `${project}-repo` },
      }, {
        organization: ORGANIZATION,
        project,
        repositoryName: `${project}-repo`,
      }, {
        organization: "derived",
        project: "fixed",
        repositoryName: "agent",
      }));
    }
    const createRequests = requests.filter((request) => request.method === "POST" && request.url.endsWith("/_apis/git/repositories?api-version=7.1"));
    assert.deepEqual(createRequests.map((request) => request.authorization), [
      `Basic ${Buffer.from(`:pat-project-a`, "utf8").toString("base64")}`,
      `Basic ${Buffer.from(`:pat-project-b`, "utf8").toString("base64")}`,
    ]);
  }, async (_url, init) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, any> : {};
    const projectID = String(body.project?.id ?? "");
    const project = [...projectIDs.entries()].find(([, id]) => id === projectID)?.[0] ?? "unknown";
    return response(200, repositoryPayload({
      name: String(body.name ?? "repository"),
      project: { id: projectID, name: project },
      remoteUrl: `https://dev.azure.com/${ORGANIZATION}/${project}/_git/${String(body.name ?? "repository")}`,
    }));
  }, async (url) => {
    const project = new URL(url).pathname.split("/").at(-1) ?? "";
    return response(200, { id: projectIDs.get(project) ?? ADO_PROJECT_ID, name: project });
  });
});

test("the retired MCP credential broker endpoint is unavailable", async () => {
  await withRepositoryBackend(async ({ runtime, context }) => {
    await assert.rejects(
      () => runtime.handle(context("get-mcp-credential", { organization: ORGANIZATION, project: ADO_PROJECT })),
      (error: unknown) => errorCode(error) === "ADO_PATH_NOT_FOUND",
    );
  }, async () => response(200, repositoryPayload()));
});

test("migrates credentials from the legacy OpenCode data path after the store path changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-devops-credential-migration-"));
  const legacyPath = join(root, "agent-web", "extension-secrets", "azure-devops-platform.json");
  const currentPath = join(root, "persistent", "azure-devops-platform.json");
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousDataRoot = process.env.OPENCODE_DATA_ROOT;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  const previousFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  process.env.EXTENSION_SECRET_KEY = randomBytes(32).toString("hex");
  process.env.OPENCODE_DATA_ROOT = root;
  process.env.ADO_CREDENTIAL_STORE_PATH = legacyPath;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({
      authorization: new Headers(init.headers).get("Authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
      method: init.method ?? "GET",
      url,
    });
    if (url.includes(`/_apis/projects/${ADO_PROJECT}`)) return response(200, projectPayload());
    return response(201, repositoryPayload());
  };

  try {
    const writer = await activate();
    await writer.handle({
      request: {
        body: { organization: ORGANIZATION, project: ADO_PROJECT, token: "pat-legacy-migrated" },
        headers: {},
        method: "POST",
        path: "store-credential",
        query: {},
      },
      host: {},
    });

    process.env.ADO_CREDENTIAL_STORE_PATH = currentPath;
    const reader = await activate();
    const policy = createDefaultAzureDevOpsParameterPolicy(ADO_PROJECT);
    const result = await reader.handle({
      request: {
        body: {
          agentInput: { repositoryName: "migrated-repository" },
          derivedValues: {},
          tool: "azure_devops_create_repository",
        },
        extensionContext: {
          azureDevOps: {
            effectiveContext: {
              adoProject: ADO_PROJECT,
              context: { organization: ORGANIZATION, project: ADO_PROJECT, parameterPolicy: policy },
              openCodeProject: "managed-project",
              organization: ORGANIZATION,
              parameterPolicy: policy,
              version: 1,
            },
            resolvedToolCall: {
              parameters: { organization: ORGANIZATION, project: ADO_PROJECT, repositoryName: "migrated-repository" },
              sources: { organization: "derived", project: "fixed", repositoryName: "agent" },
              tool: "azure_devops_create_repository",
            },
          },
        },
        headers: { "x-extension-secret-key": process.env.EXTENSION_SECRET_KEY },
        method: "POST",
        path: "create-repository",
        query: {},
      },
      host: {},
    });

    assert.equal(result.body.repository.name, "new-repository");
    assert.equal(requests.some((request) => request.authorization === `Basic ${Buffer.from(`:pat-legacy-migrated`, "utf8").toString("base64")}`), true);
    const migratedStore = await readFile(currentPath, "utf8");
    assert.equal(migratedStore.includes("pat-legacy-migrated"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
    restoreEnvironment("OPENCODE_DATA_ROOT", previousDataRoot);
    restoreEnvironment("ADO_CREDENTIAL_STORE_PATH", previousStorePath);
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects an arbitrary clone URL before Azure DevOps lookup", async () => {
  await withRepositoryBackend(async ({ runtime, requests, context }) => {
    await assert.rejects(
      runtime.handle(context("clone-repository", {
        tool: "azure_devops_clone_repository",
        agentInput: { remoteUrl: "https://attacker.example/repository.git" },
      })),
      (error: unknown) => errorCode(error) === "AZURE_DEVOPS_CLONE_REMOTE_INPUT_FORBIDDEN",
    );
    assert.equal(requests.length, 0);
  }, async () => response(200, repositoryPayload()));
});

test("rejects extra path segments, credentials, query, hash, and ports in canonical repository URLs", async () => {
  const invalidRemoteUrls = [
    `${CANONICAL_REMOTE}/extra`,
    `https://user:password@dev.azure.com/contoso/ado-project/_git/new-repository`,
    `https://other@dev.azure.com/contoso/ado-project/_git/new-repository`,
    `https://contoso:@dev.azure.com/contoso/ado-project/_git/new-repository`,
    `${CANONICAL_REMOTE}?query=unexpected`,
    `${CANONICAL_REMOTE}#fragment`,
    "https://dev.azure.com:443/contoso/ado-project/_git/new-repository",
  ];

  await withRepositoryBackend(async ({ runtime, context }) => {
    for (const remoteUrl of invalidRemoteUrls) {
      await assert.rejects(
        runtime.handle(context("create-repository", {
          tool: "azure_devops_create_repository",
          agentInput: { repositoryName: "new-repository" },
        })),
        (error: unknown) => errorCode(error) === "AZURE_DEVOPS_REPOSITORY_METADATA_INVALID"
          && errorMessage(error) === "Azure DevOps remote URL is not canonical.",
      );
      assert.equal(remoteUrl.length > 0, true);
    }
  }, async (_url, _init) => response(200, repositoryPayload({ remoteUrl: invalidRemoteUrls.shift() })));
});

type RecordedRequest = {
  authorization?: string | null;
  body?: Record<string, unknown>;
  method: string;
  url: string;
};

async function withRepositoryBackend(
  run: (fixture: {
    context: (path: string, body: Record<string, unknown>, resolvedParameters?: Record<string, unknown>, resolvedSources?: Record<string, unknown>) => Record<string, unknown>;
    requests: RecordedRequest[];
    runtime: { handle: (context: Record<string, unknown>) => Promise<any> };
  }) => Promise<void>,
  repositoryResponse: (url: string, init: RequestInit) => Promise<Response>,
  projectLookupResponse?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "azure-devops-repository-backend-"));
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.EXTENSION_SECRET_KEY;
  const previousStorePath = process.env.ADO_CREDENTIAL_STORE_PATH;
  const requests: RecordedRequest[] = [];
  process.env.EXTENSION_SECRET_KEY = randomBytes(32).toString("hex");
  process.env.ADO_CREDENTIAL_STORE_PATH = join(root, "credentials.json");
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({
      authorization: new Headers(init.headers).get("Authorization"),
      body,
      method: init.method ?? "GET",
      url,
    });
    if (url.includes("/_apis/connectionData")) return response(200, { authenticatedUser: { id: "user-id" } });
    if (url.includes("/_apis/projects?")) return response(200, { value: [{ id: ADO_PROJECT_ID, name: ADO_PROJECT }] });
    if (url.includes("/_apis/projects/")) {
      return projectLookupResponse ? projectLookupResponse(url, init) : response(200, projectPayload());
    }
    if (url.includes("/_apis/profile/")) return response(404, {});
    return repositoryResponse(url, init);
  };

  try {
    const runtime = await activate();
    await runtime.handle({
      request: {
        body: { organization: ORGANIZATION, token: PAT },
        headers: {},
        method: "POST",
        path: "verify-token",
        query: {},
      },
      host: {},
    });
    await runtime.handle({
      request: {
        body: { organization: ORGANIZATION, project: ADO_PROJECT, token: PAT },
        headers: {},
        method: "POST",
        path: "store-credential",
        query: {},
      },
      host: {},
    });
    const persistedCredentialStore = await readFile(join(root, "credentials.json"), "utf8");
    assert.equal(persistedCredentialStore.includes(PAT), false);
    assert.equal(persistedCredentialStore.includes("ciphertext"), true);
    requests.length = 0;
    await run({
      context: (path, body, resolvedParameters = {
        organization: ORGANIZATION,
        project: ADO_PROJECT,
        ...(body.agentInput as Record<string, unknown>),
      }, resolvedSources: Record<string, unknown> = {}) => {
        const selectedProject = typeof resolvedParameters.project === "string" ? resolvedParameters.project : ADO_PROJECT;
        const policy = createDefaultAzureDevOpsParameterPolicy(selectedProject);
        const effectiveContext = {
          adoProject: selectedProject,
          context: { organization: ORGANIZATION, project: selectedProject, parameterPolicy: policy },
          openCodeProject: "managed-project",
          organization: ORGANIZATION,
          parameterPolicy: policy,
          version: 1,
        };
        return {
          host: { project: "managed-project" },
          request: {
            body,
            extensionContext: {
              azureDevOps: {
                effectiveContext,
                resolvedToolCall: {
                  parameters: { ...resolvedParameters },
                  sources: resolvedSources,
                  tool: body.tool,
                },
              },
            },
            headers: { "x-extension-secret-key": process.env.EXTENSION_SECRET_KEY },
            method: "POST",
            path,
            query: { project: "managed-project", scope: "project" },
          },
        };
      },
      requests,
      runtime,
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment("EXTENSION_SECRET_KEY", previousSecret);
    restoreEnvironment("ADO_CREDENTIAL_STORE_PATH", previousStorePath);
    await rm(root, { force: true, recursive: true });
  }
}

function repositoryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPOSITORY_ID,
    name: "new-repository",
    project: { id: ADO_PROJECT_ID, name: ADO_PROJECT },
    remoteUrl: CANONICAL_REMOTE,
    ...overrides,
  };
}

function projectPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: ADO_PROJECT_ID, name: ADO_PROJECT, ...overrides };
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
