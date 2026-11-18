import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { matchesSha256Integrity, validateAicxtPackage } from "../src/features/extensions/packageValidation.js";
import { activate as activateGitLabExtensionBackend } from "../extension-packages/gitlab/backend/entry.js";
import GitLabPlugin from "../extension-packages/gitlab/plugins/gitlab/gitlab.ts";
import {
  discoverGitLabSkillPaths,
  discoverGitLabSkillGroups,
  GITLAB_SELECT_SKILL_TOOL_NAME,
  selectGitLabSkill,
} from "../extension-packages/gitlab/plugins/gitlab/gitlab-selector.js";

test("GitLab package installs its Skill catalog dynamically without bundling Skill files", async () => {
  const sourceManifest = JSON.parse(await readFile(fileURLToPath(new URL("../extension-packages/gitlab/extension.json", import.meta.url)), "utf8")) as Record<string, any>;
  const archive = await readFile(fileURLToPath(new URL("../extension-packages/gitlab.aicxt", import.meta.url)));
  const packageData = validateAicxtPackage(archive);
  const plugin = sourceManifest.resources.plugins[0];
  const skillContributions = sourceManifest.pluginContributions[0].contributions
    .filter((contribution: { kind: string }) => contribution.kind === "skill")
    .map((contribution: { name: string }) => contribution.name)
    .sort();
  const toolContributions = sourceManifest.pluginContributions[0].contributions
    .filter((contribution: { kind: string }) => contribution.kind === "tool")
    .map((contribution: { name: string }) => contribution.name)
    .sort();

  assert.equal(sourceManifest.extensionId, "gitlab");
  assert.equal(sourceManifest.scope, "project");
  assert.equal(sourceManifest.version, "2.0.0");
  assert.equal(packageData.archiveSha256, createHash("sha256").update(archive).digest("hex"));
  assert.deepEqual(packageData.manifest, sourceManifest);
  assert.equal(sourceManifest.backend.entry, "backend/entry.js");
  assert.equal(sourceManifest.backend.lifecycle.install, "install-skills");
  assert.ok(packageData.files.get("backend/entry.js"));
  assert.equal(packageData.resources.some((resource) => resource.kind === "plugins" && resource.name === "gitlab"), true);
  assert.equal(packageData.resources.some((resource) => resource.kind === "agents" && resource.name === "gitlab-skill-selector"), false);
  assert.equal(packageData.resources.filter((resource) => resource.kind === "skills").length, 0);
  assert.deepEqual(plugin.files, ["plugins/gitlab/gitlab.ts", "plugins/gitlab/gitlab-selector.js"]);
  assert.deepEqual(skillContributions, []);
  assert.deepEqual(toolContributions, [GITLAB_SELECT_SKILL_TOOL_NAME]);
  assert.equal([...packageData.files.keys()].some((path) => path.startsWith("plugins/gitlab/skills/")), false);
  assert.equal(packageData.files.has("plugins/gitlab/agents/gitlab-skill-selector.md"), false);
  assert.deepEqual(
    sourceManifest.workflowNodes,
    [{ type: "resource.plugin", name: "gitlab" }],
  );
  assert.equal(matchesSha256Integrity(
    packageData.files.get(plugin.path)!,
    plugin.integrity,
  ), true);

  for (const path of plugin.files) assert.ok(packageData.files.get(path), `${path} must be packaged as a Plugin companion file`);

  const pluginEntry = packageData.files.get("plugins/gitlab.ts")?.toString("utf8") ?? "";
  const pluginImplementation = packageData.files.get("plugins/gitlab/gitlab.ts")?.toString("utf8") ?? "";
  assert.match(pluginEntry, /export/);
  assert.match(pluginImplementation, /Plugin\.define/);
  const selector = packageData.files.get("plugins/gitlab/gitlab-selector.js")!.toString("utf8");
  assert.match(selector, /discoverGitLabSkillPaths/);
  assert.match(selector, /discoverGitLabSkillGroups/);
  assert.match(pluginImplementation, /selectGitLabSkill/);
  assert.match(selector, /gitlab_select_skill/);
  assert.match(pluginImplementation, /catalog: \{ type: "string"/);
  assert.match(selector, /SKILL\.md/);
  assert.doesNotMatch(pluginImplementation, /export const GITLAB_AGENT_NAME|materializeGitLabAgent|configWithSkills\.agent\s*=/);
  assert.match(selector, /import\.meta\.url/);
  assert.doesNotMatch(pluginImplementation, /gitlab_sync_skills|syncGitLabSkills/);
});

test("GitLab Extension install clones Skills into both project Plugin directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-system-gitlab-install-skills-"));
  const source = join(root, "source");
  const mainProjectsRoot = join(root, "main-projects");
  const workflowProjectsRoot = join(root, "workflow-projects");
  const mainPluginDirectory = join(mainProjectsRoot, "demo", ".opencode", "plugins", "gitlab");
  const workflowPluginDirectory = join(workflowProjectsRoot, "demo", ".opencode", "plugins", "gitlab");
  const skillContent = "---\nname: nested-cloud-skill\ndescription: Nested GitLab Skill\n---\nNested Skill content.\n";
  const environment = new Map([
    ["GITLAB_SKILLS_SOURCE", process.env.GITLAB_SKILLS_SOURCE],
    ["OPENCODE_PROJECTS_ROOT", process.env.OPENCODE_PROJECTS_ROOT],
    ["OPENCODE_WORKFLOW_PROJECTS_ROOT", process.env.OPENCODE_WORKFLOW_PROJECTS_ROOT],
  ]);

  try {
    await mkdir(join(source, "cloud", "gcp", "nested-cloud-skill", "references"), { recursive: true });
    await mkdir(join(mainPluginDirectory, "skills", "old-skill"), { recursive: true });
    await mkdir(join(workflowPluginDirectory, "skills", "old-skill"), { recursive: true });
    await writeFile(join(source, "cloud", "gcp", "nested-cloud-skill", "SKILL.md"), skillContent, "utf8");
    await writeFile(join(source, "cloud", "gcp", "nested-cloud-skill", "references", "setup.md"), "Install-time reference.\n", "utf8");
    await writeFile(join(mainPluginDirectory, "skills", "old-skill", "SKILL.md"), "Old bundled content.\n", "utf8");
    await writeFile(join(workflowPluginDirectory, "skills", "old-skill", "SKILL.md"), "Old bundled content.\n", "utf8");
    process.env.GITLAB_SKILLS_SOURCE = source;
    process.env.OPENCODE_PROJECTS_ROOT = mainProjectsRoot;
    process.env.OPENCODE_WORKFLOW_PROJECTS_ROOT = workflowProjectsRoot;

    const backend = await activateGitLabExtensionBackend({
      cloneRepository: async (_url: string, destination: string) => {
        await cp(source, destination, { recursive: true });
        return "local-source";
      },
    });
    const result = await backend.handle({
      host: { scope: "project", project: "demo" },
      request: { body: { repositoryUrl: "https://gitlab.example/skills" }, headers: {}, method: "POST", path: "sync-skills", query: { project: "demo", scope: "project" } },
    } as never);

    assert.deepEqual(result?.body, {
      project: "demo",
      status: "synced",
      revision: "local-source",
      skillCount: 1,
      skills: ["nested-cloud-skill"],
      pluginContributions: [{
        pluginName: "gitlab",
        contributions: [
          { kind: "skill", name: "nested-cloud-skill" },
          { kind: "tool", name: GITLAB_SELECT_SKILL_TOOL_NAME },
        ],
      }],
      targets: {
        main: { revision: "local-source", status: "synced" },
        "workflow-test": { revision: "local-source", status: "synced" },
      },
    });
    for (const pluginDirectory of [mainPluginDirectory, workflowPluginDirectory]) {
      const installedSkill = join(pluginDirectory, "skills", "cloud", "gcp", "nested-cloud-skill");
      assert.equal(await readFile(join(installedSkill, "SKILL.md"), "utf8"), skillContent);
      assert.equal(await readFile(join(installedSkill, "references", "setup.md"), "utf8"), "Install-time reference.\n");
      await assert.rejects(() => readFile(join(pluginDirectory, "skills", "old-skill", "SKILL.md")));
      await assert.rejects(() => readFile(join(dirname(pluginDirectory), "..", "skills", "nested-cloud-skill", "SKILL.md")));
    }
  } finally {
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("GitLab V2 Plugin registers its selector without changing project Agent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-system-gitlab-v2-plugin-"));
  const registeredTools = new Map<string, Record<string, unknown>>();
  const existingFiles = [
    join(root, ".opencode", "agents", "gitlab-skill-selector.md"),
    join(root, ".opencode", "plugins", "agents", "gitlab-skill-selector.md"),
    join(root, ".opencode", "plugins", "agents", "user-agent.md"),
  ];
  try {
    for (const path of existingFiles) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `preserve:${path}`, "utf8");
    }
    await GitLabPlugin.setup({
      location: { directory: root },
      tool: {
        transform: async (transform: (editor: { add(tool: Record<string, unknown>): void }) => void) => {
          transform({ add: (tool) => registeredTools.set(String(tool.name), tool) });
        },
      },
    } as never);

    assert.equal(GitLabPlugin.id, "gitlab");
    assert.equal(registeredTools.has(GITLAB_SELECT_SKILL_TOOL_NAME), true);
    assert.equal((registeredTools.get(GITLAB_SELECT_SKILL_TOOL_NAME)?.options as { codemode?: boolean }).codemode, false);
    for (const path of existingFiles) assert.equal(await readFile(path, "utf8"), `preserve:${path}`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("select_skill supports parent/catalog/skill paths and keeps legacy direct skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-system-gitlab-select-skill-"));
  const cossPath = join(root, "UI-kit", "coss", "SKILL.md");
  const bootstrapPath = join(root, "bootstrap", "backend-feature-fastapi", "SKILL.md");
  const nestedSkillPath = join(root, "cloud", "gcp", "minimal-api-service", "SKILL.md");
  const content = "---\nname: coss\ndescription: UI component guidance\n---\nCoss Skill body.\n";
  const nestedContent = "---\nname: minimal-api-service\ndescription: Build and deploy the service\n---\nNested Skill body.\n";
  try {
    await mkdir(join(root, "UI-kit", "coss"), { recursive: true });
    await mkdir(join(root, "bootstrap", "backend-feature-fastapi"), { recursive: true });
    await mkdir(join(root, "cloud", "gcp", "minimal-api-service"), { recursive: true });
    await writeFile(cossPath, content, "utf8");
    await writeFile(bootstrapPath, "---\nname: backend-feature-fastapi\n---\nFastAPI Skill body.\n", "utf8");
    await writeFile(nestedSkillPath, nestedContent, "utf8");

    assert.deepEqual(await discoverGitLabSkillGroups(root), [
      { parent: "bootstrap", skills: ["backend-feature-fastapi"], catalogs: [] },
      { parent: "cloud", skills: [], catalogs: [{ catalog: "gcp", skills: ["minimal-api-service"] }] },
      { parent: "UI-kit", skills: ["coss"], catalogs: [] },
    ]);
    assert.equal((await discoverGitLabSkillPaths(root)).includes(join(root, "cloud", "gcp", "minimal-api-service")), true);

    const catalog = await selectGitLabSkill({}, root);
    assert.ok(typeof catalog !== "string");
    assert.deepEqual(JSON.parse(catalog.content).groups, await discoverGitLabSkillGroups(root));
    const parent = await selectGitLabSkill({ parent: "cloud" }, root);
    assert.ok(typeof parent !== "string");
    assert.deepEqual(JSON.parse(parent.content), {
      parent: "cloud",
      skills: [],
      catalogs: [{ catalog: "gcp", skills: ["minimal-api-service"] }],
    });
    const category = await selectGitLabSkill({ parent: "cloud", catalog: "gcp" }, root);
    assert.ok(typeof category !== "string");
    assert.deepEqual(JSON.parse(category.content), {
      parent: "cloud",
      catalog: "gcp",
      skills: ["minimal-api-service"],
    });
    const nestedSelected = await selectGitLabSkill({ parent: "cloud", catalog: "gcp", skillName: "minimal-api-service" }, root);
    assert.ok(typeof nestedSelected !== "string");
    assert.equal(nestedSelected.content, nestedContent);
    assert.deepEqual(nestedSelected.metadata, { title: "Selected GitLab Skill: minimal-api-service", parent: "cloud", catalog: "gcp", skillName: "minimal-api-service" });
    const selected = await selectGitLabSkill({ parent: "UI-kit", skillName: "coss" }, root);
    assert.ok(typeof selected !== "string");
    assert.equal(selected.content, content);
    await assert.rejects(() => selectGitLabSkill({ parent: "cloud", skillName: "minimal-api-service" }, root));
    await assert.rejects(() => selectGitLabSkill({ parent: "cloud", catalog: "wrong" }, root));
    await assert.rejects(() => selectGitLabSkill({ parent: "..", skillName: "SKILL.md" }, root));
    await assert.rejects(() => selectGitLabSkill({ parent: "bootstrap", skillName: "coss" }, root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
