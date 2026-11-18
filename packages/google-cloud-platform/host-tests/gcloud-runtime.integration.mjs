import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GCLOUD_CONFIG_ROOT,
  DEFAULT_EXTENSION_DATA_ROOT,
  DEFAULT_PROJECT_ROOTS,
  resolveGcloudConfig,
} from "../source/runtime/gcloud-project-selector.mjs";

const repositoryRoot = path.resolve(process.env.AGENT_SYSTEM_BACKEND_ROOT, "..");
const { initializeExtensionData } = await import(new URL("opencode-server/initialize-extension-data.mjs", `${(await import("node:url")).pathToFileURL(repositoryRoot).href}/`));
const runtimeRoot = fileURLToPath(new URL("../source/runtime/", import.meta.url));
const selectorSource = path.join(runtimeRoot, "gcloud-project-selector.mjs");
const dockerfilePath = path.join(repositoryRoot, "opencode-server", "Dockerfile");
const wrapperPath = path.join(runtimeRoot, "gcloud-wrapper.sh");
const extensionDataMountPath = "/var/lib/agent-system/extensions";
const gcloudConfigPath = `${extensionDataMountPath}/google-cloud-platform/projects`;

let fixtures = [];

test("selector defaults match the documented Project roots and generic Extension data namespace", () => {
  assert.deepEqual(DEFAULT_PROJECT_ROOTS, ["/workspace/projects", "/workflow/projects"]);
  assert.equal(DEFAULT_EXTENSION_DATA_ROOT, extensionDataMountPath);
  assert.equal(DEFAULT_GCLOUD_CONFIG_ROOT, gcloudConfigPath);
});

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-system-gcloud-selector-"));
  const fixture = {
    root,
    mainRoot: path.join(root, "workspace", "projects"),
    workflowRoot: path.join(root, "workflow", "projects"),
    extensionDataRoot: path.join(root, "extension-data", "extensions"),
    configRoot: path.join(root, "extension-data", "extensions", "google-cloud-platform", "projects"),
  };
  mkdirSync(fixture.mainRoot, { recursive: true });
  mkdirSync(fixture.workflowRoot, { recursive: true });
  mkdirSync(fixture.configRoot, { recursive: true });
  mkdirSync(fixture.extensionDataRoot, { recursive: true });
  fixtures.push(root);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
  fixtures = [];
});

function selectConfig(fixture, cwd, env = {}) {
  return resolveGcloudConfig({
    cwd,
    env,
    projectRoots: [fixture.mainRoot, fixture.workflowRoot],
    configRoot: fixture.configRoot,
  });
}

test("使用者安裝器擁有 CLI 與 wrapper，宿主 image 不下載 CLI", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const wrapper = readFileSync(wrapperPath, "utf8");
  const installer = readFileSync(path.join(runtimeRoot, "install-gcloud.sh"), "utf8");

  assert.doesNotMatch(dockerfile, /google-cloud-cli|gcloud-wrapper|gcloud-project-selector/);
  assert.match(installer, /https:\/\/packages\.cloud\.google\.com\/apt\/doc\/apt-key\.gpg/);
  assert.match(installer, /signed-by=\/usr\/share\/keyrings\/cloud\.google\.gpg/);
  assert.match(installer, /google-cloud-cli=558\.0\.0-0/);
  assert.match(installer, /Google Cloud SDK 558\.0\.0/);
  assert.match(dockerfile, /COPY opencode-server\/initialize-extension-data\.mjs \/usr\/local\/bin\/initialize-extension-data\.mjs/);
  assert.match(wrapper, /\$\{CLOUDSDK_CONFIG\+x\}/);
  const selectorIndex = wrapper.indexOf('selected_config="$(node /usr/local/libexec/gcloud-project-selector.mjs)"');
  const execIndex = wrapper.indexOf('exec /usr/lib/google-cloud-sdk/bin/gcloud "$@"');
  assert.ok(selectorIndex >= 0 && selectorIndex < execIndex, "selector runs before forwarding CLI arguments");
  assert.ok(readFileSync(selectorSource, "utf8").includes("DEFAULT_GCLOUD_CONFIG_ROOT"));
});

test("cwd in main and workflow-test Project roots selects each Project config", () => {
  const fixture = createFixture();
  const mainProject = path.join(fixture.mainRoot, "alpha-project", "repository");
  const workflowProject = path.join(fixture.workflowRoot, "alpha-project", "repository");
  mkdirSync(mainProject, { recursive: true });
  mkdirSync(workflowProject, { recursive: true });

  assert.equal(
    selectConfig(fixture, mainProject),
    path.join(fixture.configRoot, "alpha-project"),
  );
  assert.equal(
    selectConfig(fixture, workflowProject),
    path.join(fixture.configRoot, "alpha-project"),
  );
});

test("different Agent System Projects map to different config directories", () => {
  const fixture = createFixture();
  const firstProject = path.join(fixture.mainRoot, "alpha-project");
  const secondProject = path.join(fixture.workflowRoot, "beta-project");
  mkdirSync(firstProject);
  mkdirSync(secondProject);

  const firstConfig = selectConfig(fixture, firstProject);
  const secondConfig = selectConfig(fixture, secondProject);

  assert.notEqual(firstConfig, secondConfig);
  assert.equal(firstConfig, path.join(fixture.configRoot, "alpha-project"));
  assert.equal(secondConfig, path.join(fixture.configRoot, "beta-project"));
});

test("the generic Extension data root override keeps GCP config inside its package namespace", () => {
  const fixture = createFixture();
  const projectDirectory = path.join(fixture.mainRoot, "alpha-project");
  mkdirSync(projectDirectory);

  assert.equal(resolveGcloudConfig({
    cwd: projectDirectory,
    env: { AGENT_SYSTEM_EXTENSION_DATA_ROOT: fixture.extensionDataRoot },
    projectRoots: [fixture.mainRoot],
  }), path.join(fixture.configRoot, "alpha-project"));
  assert.throws(() => resolveGcloudConfig({
    cwd: projectDirectory,
    env: { AGENT_SYSTEM_EXTENSION_DATA_ROOT: "relative/extensions" },
    projectRoots: [fixture.mainRoot],
  }), /config root must be an absolute path/);
});

test("explicit CLOUDSDK_CONFIG wins even outside Project context and is preserved", () => {
  const fixture = createFixture();
  const unrelatedCwd = path.join(fixture.root, "unmanaged");
  mkdirSync(unrelatedCwd);
  const explicitConfig = path.join(fixture.root, "selected-config");

  assert.equal(
    selectConfig(fixture, unrelatedCwd, { CLOUDSDK_CONFIG: explicitConfig }),
    explicitConfig,
  );
  assert.equal(selectConfig(fixture, unrelatedCwd, { CLOUDSDK_CONFIG: "" }), "");
  assert.equal(existsSync(explicitConfig), false);
});

test("missing Project context fails closed", () => {
  const fixture = createFixture();
  const unrelatedCwd = path.join(fixture.root, "unmanaged");
  mkdirSync(unrelatedCwd);

  assert.throws(() => selectConfig(fixture, unrelatedCwd), /requires a cwd under/);
  assert.throws(() => selectConfig(fixture, fixture.mainRoot), /requires a cwd under/);
});

test("unsafe Project names and cwd traversal are rejected", () => {
  const fixture = createFixture();
  const unsafeProjects = [
    "project with spaces",
    "project.with.dots",
    "a".repeat(81),
  ].map((name) => path.join(fixture.mainRoot, name));
  const outside = path.join(fixture.root, "outside");
  for (const unsafeProject of unsafeProjects) mkdirSync(unsafeProject);
  mkdirSync(outside);

  for (const unsafeProject of unsafeProjects) {
    assert.throws(() => selectConfig(fixture, unsafeProject), /context path is unsafe/);
  }
  assert.throws(() => selectConfig(fixture, path.join(fixture.mainRoot, "..", "..", "outside")), /requires a cwd under/);
  assert.throws(() => resolveGcloudConfig({
    cwd: unsafeProjects[0],
    env: {},
    projectRoots: [fixture.mainRoot],
    configRoot: "relative/config",
  }), /config root must be an absolute path/);
});

test("a Project config symlink is rejected rather than followed", (context) => {
  const fixture = createFixture();
  const projectDirectory = path.join(fixture.mainRoot, "alpha-project");
  const externalConfig = path.join(fixture.root, "external-config");
  mkdirSync(projectDirectory);
  mkdirSync(externalConfig);
  try {
    symlinkSync(externalConfig, path.join(fixture.configRoot, "alpha-project"), "dir");
  } catch (error) {
    if (error && typeof error === "object" && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
      context.skip("platform does not permit creating a test symlink");
      return;
    }
    throw error;
  }

  assert.throws(() => selectConfig(fixture, projectDirectory), /must not be a symbolic link/);
});

test("a cwd symlink escaping a managed Project root fails closed", (context) => {
  const fixture = createFixture();
  const outside = path.join(fixture.root, "outside-project");
  const projectLink = path.join(fixture.mainRoot, "linked-project");
  mkdirSync(outside);
  try {
    symlinkSync(outside, projectLink, "dir");
  } catch (error) {
    if (error && typeof error === "object" && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
      context.skip("platform does not permit creating a test symlink");
      return;
    }
    throw error;
  }

  assert.throws(() => selectConfig(fixture, projectLink), /requires a cwd under/);
});

function createExtensionDataFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-system-extension-data-"));
  fixtures.push(root);
  const fixture = {
    root,
    dataRoot: path.join(root, "data"),
    legacySecretsRoot: path.join(root, "legacy-secrets"),
  };
  mkdirSync(fixture.legacySecretsRoot, { recursive: true });
  return fixture;
}

test("initializer migrates legacy secrets into generic Extension data and preserves the source", async () => {
  const fixture = createExtensionDataFixture();
  const nestedLegacyDirectory = path.join(fixture.legacySecretsRoot, "provider");
  mkdirSync(nestedLegacyDirectory);
  writeFileSync(path.join(fixture.legacySecretsRoot, "azure-devops-platform.json"), "synthetic-secret-record", "utf8");
  writeFileSync(path.join(nestedLegacyDirectory, "config.json"), "synthetic-nested-secret", "utf8");

  const result = await initializeExtensionData(fixture);

  assert.deepEqual(result, { migrated: true });
  assert.equal(readFileSync(path.join(fixture.dataRoot, "extension-secrets", "azure-devops-platform.json"), "utf8"), "synthetic-secret-record");
  assert.equal(readFileSync(path.join(fixture.dataRoot, "extension-secrets", "provider", "config.json"), "utf8"), "synthetic-nested-secret");
  assert.equal(existsSync(path.join(fixture.dataRoot, "extensions")), true);
  assert.equal(readFileSync(path.join(fixture.legacySecretsRoot, "azure-devops-platform.json"), "utf8"), "synthetic-secret-record");
});

test("initializer marks legacy migration once and never overwrites later Extension secrets", async () => {
  const fixture = createExtensionDataFixture();
  const legacySecret = path.join(fixture.legacySecretsRoot, "credential.json");
  const migratedSecret = path.join(fixture.dataRoot, "extension-secrets", "credential.json");
  writeFileSync(legacySecret, "synthetic-original", "utf8");

  assert.deepEqual(await initializeExtensionData(fixture), { migrated: true });
  writeFileSync(migratedSecret, "synthetic-current-secret", "utf8");
  writeFileSync(legacySecret, "synthetic-stale-copy", "utf8");

  assert.deepEqual(await initializeExtensionData(fixture), { migrated: false });
  assert.equal(readFileSync(migratedSecret, "utf8"), "synthetic-current-secret");
});

test("initializer resumes after an interrupted staged secret copy", async () => {
  const fixture = createExtensionDataFixture();
  const legacySecret = path.join(fixture.legacySecretsRoot, "credential.json");
  const stagingRoot = path.join(fixture.dataRoot, ".legacy-backend-extension-secrets-staging");
  const stagingName = createHash("sha256").update("credential.json").digest("hex");
  writeFileSync(legacySecret, "synthetic-complete-secret", "utf8");
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(path.join(stagingRoot, stagingName), "interrupted-partial-copy", "utf8");

  assert.deepEqual(await initializeExtensionData(fixture), { migrated: true });
  assert.equal(readFileSync(path.join(fixture.dataRoot, "extension-secrets", "credential.json"), "utf8"), "synthetic-complete-secret");
  assert.equal(existsSync(path.join(stagingRoot, stagingName)), false);
  assert.equal(readFileSync(legacySecret, "utf8"), "synthetic-complete-secret");
});

test("initializer repairs an interrupted staged migration marker", async () => {
  const fixture = createExtensionDataFixture();
  const stagingRoot = path.join(fixture.dataRoot, ".legacy-backend-extension-secrets-staging");
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(path.join(stagingRoot, "migration-marker"), "interrupted-marker", "utf8");

  assert.deepEqual(await initializeExtensionData(fixture), { migrated: true });
  assert.equal(readFileSync(path.join(fixture.dataRoot, ".legacy-backend-extension-secrets-migrated"), "utf8"), "1\n");
  assert.equal(existsSync(path.join(stagingRoot, "migration-marker")), false);
});

test("initializer fails closed on conflicting destination secrets without overwriting either copy", async () => {
  const fixture = createExtensionDataFixture();
  const legacySecret = path.join(fixture.legacySecretsRoot, "credential.json");
  const destinationSecret = path.join(fixture.dataRoot, "extension-secrets", "credential.json");
  mkdirSync(path.dirname(destinationSecret), { recursive: true });
  writeFileSync(legacySecret, "synthetic-legacy-secret", "utf8");
  writeFileSync(destinationSecret, "synthetic-existing-secret", "utf8");

  await assert.rejects(initializeExtensionData(fixture), /conflict/);
  assert.equal(readFileSync(legacySecret, "utf8"), "synthetic-legacy-secret");
  assert.equal(readFileSync(destinationSecret, "utf8"), "synthetic-existing-secret");
  assert.equal(existsSync(path.join(fixture.dataRoot, ".legacy-backend-extension-secrets-migrated")), false);
});

test("initializer rejects symbolic links in the legacy secret volume", async (context) => {
  const fixture = createExtensionDataFixture();
  const outsideSecret = path.join(fixture.root, "outside-secret");
  writeFileSync(outsideSecret, "synthetic-secret", "utf8");
  try {
    symlinkSync(outsideSecret, path.join(fixture.legacySecretsRoot, "linked-secret"), "file");
  } catch (error) {
    if (error && typeof error === "object" && ["EACCES", "EPERM", "ENOTSUP"].includes(error.code)) {
      context.skip("platform does not permit creating a test symlink");
      return;
    }
    throw error;
  }

  await assert.rejects(initializeExtensionData(fixture), /symbolic link/);
  assert.equal(readFileSync(outsideSecret, "utf8"), "synthetic-secret");
});

function composeConfig(composeFile, { projectName, worktreeName }) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "agent-system-gcloud-compose-"));
  const envFile = path.join(tempRoot, "synthetic-compose.env");
  const envLines = [
    `WORKTREE_COMPOSE_PROJECT_NAME=${projectName}`,
    "WORKTREE_OPENCODE_SERVER_PASSWORD=synthetic-compose-password",
    "OPENCODE_SERVER_PASSWORD=synthetic-compose-password",
    "EXTENSION_SECRET_KEY=synthetic-compose-extension-key",
    "STG_COMPOSE_PROJECT_NAME=agent-system-gcloud-ticket-01-stg-contract",
    `PROD_BACKEND_IMAGE=synthetic/backend@sha256:${"a".repeat(64)}`,
    `PROD_OPENCODE_IMAGE=synthetic/opencode@sha256:${"b".repeat(64)}`,
  ];
  if (worktreeName) envLines.push(`WORKTREE_NAME=${worktreeName}`);
  writeFileSync(envFile, envLines.join("\n"), "utf8");

  const environment = {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    TEMP: tempRoot,
    TMP: tempRoot,
  };
  for (const key of ["SystemRoot", "PATHEXT", "HOME", "USERPROFILE"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (process.env.DOCKER_CONFIG) environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;

  try {
    const result = spawnSync("docker", [
      "compose",
      "--project-directory", repositoryRoot,
      "--env-file", envFile,
      "-f", path.join(repositoryRoot, composeFile),
      "config",
      "--format", "json",
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    if (result.error) {
      throw new Error(`docker compose config could not complete: ${result.error.message}`);
    }
    assert.equal(result.status, 0, `docker compose config failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertExtensionDataVolume(config, volumeKey, legacyVolumeKey) {
  const backend = config.services.backend;
  const initializer = config.services["extension-data-init"];
  const main = config.services["opencode-server"];
  const workflow = config.services["opencode-workflow-server"];
  assert.ok(backend, "backend service exists");
  assert.ok(initializer, "one-shot Extension data initializer exists");
  assert.ok(main, "main OpenCode service exists");
  assert.ok(workflow, "workflow-test OpenCode service exists");
  assert.equal(initializer.image, main.image, "initializer uses the OpenCode runtime image");
  assert.equal(backend.environment.EXTENSION_SECRET_KEY !== undefined, true,
    "backend retains its extension secret encryption key");
  assert.equal(main.environment.AGENT_SYSTEM_EXTENSION_DATA_ROOT, extensionDataMountPath);
  assert.equal(workflow.environment.AGENT_SYSTEM_EXTENSION_DATA_ROOT, extensionDataMountPath);
  assert.equal(Object.hasOwn(main.environment, "EXTENSION_SECRET_KEY"), false);
  assert.equal(Object.hasOwn(workflow.environment, "EXTENSION_SECRET_KEY"), false);
  assert.equal(main.depends_on["extension-data-init"].condition, "service_completed_successfully");
  assert.equal(workflow.depends_on["extension-data-init"].condition, "service_completed_successfully");
  assert.equal(initializer.restart, "no");
  assert.deepEqual(initializer.entrypoint, ["node", "/usr/local/bin/initialize-extension-data.mjs"]);

  const backendMount = backend.volumes.find((mount) => mount.target === "/var/lib/agent-system");
  assert.ok(backendMount, "backend mounts the generic Extension data volume root");
  assert.equal(backendMount.type, "volume");
  assert.equal(backendMount.source, volumeKey);
  assert.equal(backend.volumes.some((mount) => mount.source === legacyVolumeKey), false,
    "backend no longer mounts the legacy secrets volume");

  const initializerDataMount = initializer.volumes.find((mount) => mount.target === "/data");
  const initializerLegacyMount = initializer.volumes.find((mount) => mount.target === "/legacy-secrets");
  assert.equal(initializerDataMount.source, volumeKey);
  assert.equal(initializerLegacyMount.source, legacyVolumeKey);
  assert.equal(initializerLegacyMount.read_only, true);

  const mainMount = main.volumes.find((mount) => mount.target === extensionDataMountPath);
  const workflowMount = workflow.volumes.find((mount) => mount.target === extensionDataMountPath);
  assert.ok(mainMount, "main runtime mounts the Extension data subpath");
  assert.ok(workflowMount, "workflow-test runtime mounts the Extension data subpath");
  assert.equal(mainMount.type, "volume");
  assert.equal(workflowMount.type, "volume");
  assert.equal(mainMount.source, volumeKey);
  assert.equal(workflowMount.source, volumeKey);
  assert.equal(mainMount.volume.subpath, "extensions");
  assert.equal(workflowMount.volume.subpath, "extensions");
  assert.equal(mainMount.source, workflowMount.source);
  assert.equal(main.volumes.some((mount) => mount.target === "/var/lib/agent-system/extension-secrets"), false);
  assert.equal(workflow.volumes.some((mount) => mount.target === "/var/lib/agent-system/extension-secrets"), false);
  assert.equal(Object.hasOwn(config.volumes, "gcloud-data"), false,
    "gcloud-only storage is replaced by the generic Extension data volume");

  return config.volumes[volumeKey].name;
}

function assertOpenCodeBuildContract(config, expectedEnvironment, expectedChannel, buildServices) {
  for (const serviceName of buildServices) {
    const service = config.services[serviceName];
    assert.ok(service, `${serviceName} service exists`);
    assert.ok(service.build, `${serviceName} has an image build`);
    assert.equal(path.resolve(service.build.context), repositoryRoot, `${serviceName} builds from repository root`);
    assert.equal(path.resolve(repositoryRoot, service.build.dockerfile), dockerfilePath);
    assert.equal(service.build.args.OPENCODE_VERSION, "2.2.5");
    assert.equal(service.build.args.DEFAULT_WORKFLOW_SOURCE_ENVIRONMENT, expectedEnvironment);
    assert.equal(service.build.args.DEFAULT_WORKFLOW_SOURCE_CHANNEL, expectedChannel);
  }
}

function dockerfileCopySources(dockerfile) {
  const logicalLines = dockerfile.replace(/\\\r?\n[\t ]*/g, " ").split(/\r?\n/);
  const sources = [];

  for (const line of logicalLines) {
    const match = line.match(/^\s*COPY\s+(.+)$/i);
    if (!match) continue;
    const payload = match[1].trim();
    let tokens;
    if (payload.startsWith("[")) {
      tokens = JSON.parse(payload);
      assert.ok(Array.isArray(tokens) && tokens.length >= 2, "JSON COPY form has sources and destination");
    } else {
      tokens = payload.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) ?? [];
      tokens = tokens.map((token) => token.replace(/^['"]|['"]$/g, ""));
    }

    let fromStage = false;
    const operands = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "--from") {
        fromStage = true;
        index += 1;
      } else if (token.startsWith("--from=")) {
        fromStage = true;
      } else if (!token.startsWith("--")) {
        operands.push(token);
      }
    }
    if (fromStage) continue;
    sources.push(...operands.slice(0, -1));
  }

  return sources;
}

test("DEV and STG root-context build args and generic Extension volume contract match", () => {
  const dev = composeConfig("docker-compose.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-01-build-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-01",
  });
  const stg = composeConfig("docker-compose.stg.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-01-stg-build-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-01-stg",
  });
  const dockerfile = readFileSync(dockerfilePath, "utf8");

  assertOpenCodeBuildContract(dev, "dev", "stable", ["opencode-server"]);
  assert.equal(dev.services["opencode-server"].image, dev.services["opencode-workflow-server"].image);
  assertOpenCodeBuildContract(stg, "staging", "stable", ["opencode-server"]);
  assertExtensionDataVolume(dev, "extension-data", "legacy-backend-extension-secrets");
  assertExtensionDataVolume(stg, "stg-extension-data", "stg-legacy-backend-extension-secrets");
  assert.equal(
    stg.services["opencode-server"].image,
    stg.services["opencode-workflow-server"].image,
    "STG workflow-test consumes the same built OpenCode image",
  );
  assert.match(dockerfile, /COPY --from=default-workflow-source \//);
  assert.match(dockerfile, /COPY --from=default-workflow-backend-image \//);
});

test("every local Dockerfile COPY source exists from repository root", () => {
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  for (const source of dockerfileCopySources(dockerfile)) {
    assert.equal(path.isAbsolute(source), false, `COPY source must be repository-relative: ${source}`);
    const matches = globSync(source, { cwd: repositoryRoot });
    assert.ok(matches.length > 0, `COPY source exists from repository root: ${source}`);
    for (const match of matches) {
      assert.ok(existsSync(path.resolve(repositoryRoot, match)), `COPY source resolves from repository root: ${match}`);
    }
  }
});

test("dev, stg, prod, and isolated worktrees resolve to separate Extension data volumes", () => {
  const devDefault = composeConfig("docker-compose.yaml", {
    projectName: "agent-system",
  });
  const dev = composeConfig("docker-compose.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-01-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-01",
  });
  const devOtherWorktree = composeConfig("docker-compose.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-02-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-02",
  });
  const stg = composeConfig("docker-compose.stg.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-01-stg-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-01-stg",
  });
  const prod = composeConfig("docker-compose.prod.yaml", {
    projectName: "gcloud-opencode-runtime-tickets-01-prod-contract",
    worktreeName: "gcloud-opencode-runtime-tickets-01-prod",
  });

  const volumeNames = [
    assertExtensionDataVolume(devDefault, "extension-data", "legacy-backend-extension-secrets"),
    assertExtensionDataVolume(dev, "extension-data", "legacy-backend-extension-secrets"),
    assertExtensionDataVolume(devOtherWorktree, "extension-data", "legacy-backend-extension-secrets"),
    assertExtensionDataVolume(stg, "stg-extension-data", "stg-legacy-backend-extension-secrets"),
    assertExtensionDataVolume(prod, "extension-data", "legacy-backend-extension-secrets"),
  ];
  assert.deepEqual(volumeNames, [
    "dev-agent-system-extension-data",
    "dev-gcloud-opencode-runtime-tickets-01-extension-data",
    "dev-gcloud-opencode-runtime-tickets-02-extension-data",
    "agent-system-stg-v2-extension-data",
    "agent-system-extension-data",
  ]);
  assert.deepEqual([
    devDefault.volumes["legacy-backend-extension-secrets"].name,
    dev.volumes["legacy-backend-extension-secrets"].name,
    devOtherWorktree.volumes["legacy-backend-extension-secrets"].name,
    stg.volumes["stg-legacy-backend-extension-secrets"].name,
    prod.volumes["legacy-backend-extension-secrets"].name,
  ], [
    "agent-system-backend-extension-secrets",
    "gcloud-opencode-runtime-tickets-01-backend-extension-secrets",
    "gcloud-opencode-runtime-tickets-02-backend-extension-secrets",
    "agent-system-stg-v2-backend-extension-secrets",
    "agent-system-backend-extension-secrets",
  ], "legacy secret volume identities stay attached read-only for migration");
  assert.equal(new Set(volumeNames).size, volumeNames.length);
});
