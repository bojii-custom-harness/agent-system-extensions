import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { readAicxtManifest } from "../packages/cli/src/zip.js";

const EXTENSION_IDS = ["azure-devops-platform", "google-cloud-platform", "gitlab", "open-design", "xmind"];
const RELEASE_VERSIONS = {
  "azure-devops-platform": "3.0.1",
  "google-cloud-platform": "2.0.4",
  gitlab: "2.0.0",
  "open-design": "2.0.1",
  xmind: "2.0.1",
};
const packageRoot = resolve("packages");

async function packagePath(extensionId, ...parts) {
  return join(packageRoot, extensionId, ...parts);
}

test("Ticket 02 publishes only the five formal Extension packages with source provenance", async () => {
  const directories = await readdir(packageRoot, { withFileTypes: true });
  const formal = directories.filter((entry) => entry.isDirectory() && EXTENSION_IDS.includes(entry.name)).map((entry) => entry.name).sort();
  assert.deepEqual(formal, [...EXTENSION_IDS].sort());
  assert.equal(directories.some((entry) => entry.name === "local-native-resources"), false);

  for (const extensionId of EXTENSION_IDS) {
    const source = JSON.parse(await readFile(await packagePath(extensionId, "source.json"), "utf8"));
    assert.equal(source.extensionId, extensionId);
    assert.equal(source.repository, "agent-system");
    assert.match(source.sourceTree, /^[a-f0-9]{40}$/);
    assert.ok(source.sourcePath);
    assert.ok(source.sourceRevision);
    assert.notEqual(source.sourceRevision, "6328628617abeb17d12886487387c7cd35023965");
    assert.notEqual(source.sourceRevision, "historical-2.0.0");
    if (extensionId === "google-cloud-platform") {
      assert.equal(source.snapshotCommit, "ccf5672c8ef5c43abbc89896a98b0760bddf74ef");
      assert.equal(source.sourceContentCommit, "bc11548ad8a8d4b1d1ed68923570e8484390518f");
      assert.equal(source.sourcePackageVersion, "2.3.9");
      assert.equal(source.releaseVersion, "2.0.4");
    } else {
      assert.equal(source.snapshotCommit, "b3040627401c9fe6a6955051022f0e602d602398");
    }
  }
});

test("each deterministic build matches its tracked release archive and manifest", async () => {
  const { buildExtensionPackage } = await import("../scripts/build-extension-packages.js");
  for (const extensionId of EXTENSION_IDS) {
    const version = RELEASE_VERSIONS[extensionId];
    const { archive, manifest } = await buildExtensionPackage(extensionId);
    const tracked = await readFile(await packagePath(extensionId, `${extensionId}-${version}.aicxt`));
    assert.ok(archive.equals(tracked), `${extensionId} archive is stale; run npm run extensions:build -- ${extensionId}`);
    assert.equal(manifest.extensionId, extensionId);
    assert.equal(manifest.version, version);
    const unpacked = readAicxtManifest(archive);
    assert.equal(unpacked.extensionId, extensionId);
    assert.equal(unpacked.version, version);
  }
});

test("package entry, resource and declared asset integrity hashes match packaged bytes", async () => {
  const { buildExtensionPackage } = await import("../scripts/build-extension-packages.js");
  for (const extensionId of EXTENSION_IDS) {
    const { files, manifest } = await buildExtensionPackage(extensionId);
    for (const section of ["backend", "frontend", "configuration"]) {
      for (const [path, expected] of Object.entries(manifest[section]?.integrity ?? {})) {
        assert.equal(`sha256-${createHash("sha256").update(files.get(path)).digest("hex")}`, expected, `${extensionId}:${path}`);
      }
    }
    for (const plugin of manifest.resources?.plugins ?? []) {
      assert.equal(`sha256-${createHash("sha256").update(files.get(plugin.path)).digest("hex")}`, plugin.integrity, `${extensionId}:${plugin.path}`);
      for (const path of plugin.files) assert.ok(files.has(path), `${extensionId}:${path} companion file is packaged`);
    }
  }
});
