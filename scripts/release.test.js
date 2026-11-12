import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readRegistryPackage,
  selectRelease,
  validateArtifact,
  validateManifest,
  verifyUnpublished,
  verifyWorkspaceDependencies,
} from "./release.js";

const packages = [
  { id: "core", name: "@example/core", directory: "packages/core" },
  { id: "core-utils", name: "@example/utils", directory: "packages/utils" },
];
const manifest = {
  name: "@example/core",
  version: "1.2.3",
  type: "module",
  main: "./index.js",
  exports: "./index.js",
  publishConfig: { access: "public" },
};
const selection = selectRelease(packages, { tag: "core-v1.2.3" });
const release = validateManifest(selection, manifest);

test("package-specific tags select one explicitly mapped library", () => {
  assert.equal(selection.name, "@example/core");
  assert.equal(selection.taggedVersion, "1.2.3");
  assert.equal(
    selectRelease(packages, { tag: "core-utils-v2.0.0" }).name,
    "@example/utils",
  );
  assert.equal(
    selectRelease(packages, { packageId: "core" }).taggedVersion,
    undefined,
  );
  const overlapping = [
    ...packages,
    { id: "core-v2", name: "@example/core-v2", directory: "packages/core-v2" },
  ];
  assert.equal(
    selectRelease(overlapping, { tag: "core-v2-v1.0.0" }).id,
    "core-v2",
  );
});

test("unknown tags, paths, duplicate mappings and noncanonical versions fail", () => {
  for (const tag of [
    "v1.2.3",
    "unknown-v1.2.3",
    "core-v",
    "core-v01.2.3",
    "core-vv1.2.3",
    "core-v1.2.3\n",
    "core-v1.2.3+build",
  ]) {
    assert.throws(() => selectRelease(packages, { tag }));
  }
  assert.throws(() => selectRelease(packages, { packageId: "../core" }));
  for (const entry of [
    packages[0],
    { ...packages[0], id: "other" },
    { id: "other", name: "@example/other", directory: "apps/app" },
    { id: "other", name: "@example/other", directory: "packages/../core" },
  ]) {
    assert.throws(() =>
      selectRelease([...packages, entry], { tag: "core-v1.2.3" }),
    );
  }
});

test("the selected package, not the root, must match the tag exactly", () => {
  assert.equal(release.version, "1.2.3");
  assert.equal(release.distTag, "latest");
  for (const changes of [
    { name: "@example/other" },
    { version: "1.2.4" },
    { version: "1.2.3-rc.1" },
    { version: 123 },
    { version: "v1.2.3" },
    { private: true },
    { publishConfig: undefined },
    { publishConfig: { access: "restricted" } },
    { publishConfig: { access: "public", registry: "https://other.invalid/" } },
    { publishConfig: { access: "public", directory: "dist" } },
  ]) {
    assert.throws(() =>
      validateManifest(selection, { ...manifest, ...changes }),
    );
  }
  assert.throws(() =>
    validateManifest(
      { ...selection, name: "@workspace/core" },
      { ...manifest, name: "@workspace/core" },
    ),
  );
});

test("prerelease suffixes must match exactly and never publish as latest", () => {
  const selected = selectRelease(packages, { tag: "core-v2.0.0-rc.0" });
  assert.equal(
    validateManifest(selected, { ...manifest, version: "2.0.0-rc.0" }).distTag,
    "rc",
  );
  validateArtifact(
    validateManifest(selected, { ...manifest, version: "2.0.0-rc.0" }),
    { ...manifest, version: "2.0.0-rc.0" },
  );
  assert.throws(() =>
    validateManifest(selected, { ...manifest, version: "2.0.0-rc.1" }),
  );
});

test("only rc prereleases with a nonnegative integer suffix are supported", () => {
  const selected = selectRelease(packages, { packageId: "core" });
  for (const version of ["2.0.0-rc.1", "2.0.0-rc.10"]) {
    assert.equal(
      validateManifest(selectRelease(packages, { tag: `core-v${version}` }), {
        ...manifest,
        version,
      }).distTag,
      "rc",
    );
  }
  for (const version of [
    "2.0.0-beta.0",
    "2.0.0-beta-rc.0",
    "2.0.0-rc",
    "2.0.0-rc.01",
    "2.0.0-rc.-1",
    "2.0.0-rc.1.0",
    "2.0.0-rc.n",
    "2.0.0-rc.0+build",
  ]) {
    assert.throws(() => selectRelease(packages, { tag: `core-v${version}` }));
    assert.throws(() => validateManifest(selected, { ...manifest, version }));
    assert.throws(() => validateArtifact(release, { ...manifest, version }));
  }
});

test("artifact name and version must match; local dependency protocols fail", () => {
  validateArtifact(release, manifest);
  for (const changes of [
    { name: "@example/other" },
    { version: "1.2.4" },
    { private: true },
  ]) {
    assert.throws(() => validateArtifact(release, { ...manifest, ...changes }));
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const range of [
      "workspace:*",
      "file:../core",
      "link:../core",
      "portal:../core",
      123,
    ]) {
      assert.throws(() =>
        validateArtifact(release, {
          ...manifest,
          [field]: { "@example/utils": range },
        }),
      );
    }
  }
});

test("internal runtime and peer dependencies must be published separately", async () => {
  const names = new Set(["@example/utils"]);
  const published = async () => ({
    versions: { "1.0.0": {}, "2.0.0-rc.1": {} },
  });
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    await verifyWorkspaceDependencies(
      { [field]: { "@example/utils": "^1.0.0" } },
      names,
      published,
    );
    for (const range of ["^3.0.0", "workspace:*", "npm:other@1.0.0"]) {
      await assert.rejects(
        verifyWorkspaceDependencies(
          { [field]: { "@example/utils": range } },
          names,
          published,
        ),
      );
    }
    await assert.rejects(
      verifyWorkspaceDependencies(
        { [field]: { "@example/utils": "^1.0.0" } },
        names,
        async () => null,
      ),
      /publish the dependency separately/u,
    );
    await assert.rejects(
      verifyWorkspaceDependencies(
        { [field]: { "@example/utils": "^2.0.0" } },
        names,
        published,
      ),
    );
  }
  await verifyWorkspaceDependencies(
    { dependencies: { "@example/utils": "2.0.0-rc.1" } },
    names,
    published,
  );
  await verifyWorkspaceDependencies(
    {
      dependencies: { external: "*" },
      devDependencies: { "@example/utils": "*" },
    },
    names,
    () => {
      throw new Error("Must not look up non-runtime or external dependencies");
    },
  );
});

test("registry errors fail closed, and only HTTP 404 means a missing package", async () => {
  assert.equal(
    await readRegistryPackage("missing", async () => ({ status: 404 })),
    null,
  );
  assert.deepEqual(
    await readRegistryPackage("@example/core", async (url) => {
      assert.equal(url, "https://registry.npmjs.org/%40example%2Fcore");
      return { ok: true, json: async () => ({ versions: { "1.2.3": {} } }) };
    }),
    { versions: { "1.2.3": {} } },
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      readRegistryPackage("core", async () => ({ ok: false, status })),
      /lookup failed/u,
    );
  }
  for (const body of [null, {}, { versions: null }, { versions: [] }]) {
    await assert.rejects(
      readRegistryPackage("core", async () => ({
        ok: true,
        json: async () => body,
      })),
      /Invalid npm registry metadata/u,
    );
  }
  await assert.rejects(
    readRegistryPackage("core", async () => {
      throw new Error("network unavailable");
    }),
    /network unavailable/u,
  );
});

test("existing npm versions block release and registry failures cannot bypass the guard", async () => {
  await verifyUnpublished(release, async () => null);
  await verifyUnpublished(release, async () => ({ versions: { "1.2.2": {} } }));
  await assert.rejects(
    verifyUnpublished(release, async () => ({ versions: { "1.2.3": {} } })),
    /already published/u,
  );
  await assert.rejects(
    verifyUnpublished(release, async () => {
      throw new Error("registry unavailable");
    }),
    /registry unavailable/u,
  );
});

test("pnpm packs once without hooks, converts workspace dependencies and passes publint", () => {
  const directory = mkdtempSync(join(tmpdir(), "monorepo-release-"));
  try {
    writeFileSync(
      join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true }),
    );
    for (const [id, name] of [
      ["core", "@example/core"],
      ["utils", "@example/utils"],
    ]) {
      const path = join(directory, "packages", id);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({
          ...manifest,
          name,
          files: ["index.js"],
          dependencies:
            id === "core" ? { "@example/utils": "workspace:*" } : {},
          scripts: { prepack: 'node -e "process.exit(99)"' },
        }),
      );
      writeFileSync(join(path, "index.js"), "export const example = true;\n");
    }
    const tarball = join(directory, "release.tgz");
    // Use the same pnpm executable that launched the repository test command.
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm, "Run this test through pnpm test:release");
    const args = [
      "--config.ignore-scripts=true",
      "--dir",
      join(directory, "packages", "core"),
      "pack",
      "--out",
      tarball,
    ];
    const executable = pnpm.endsWith(".exe") ? pnpm : process.execPath;
    const installArgs = [
      "--dir",
      directory,
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-frozen-lockfile",
    ];
    execFileSync(
      executable,
      executable === pnpm ? installArgs : [pnpm, ...installArgs],
      { env: process.env, encoding: "utf8", stdio: "pipe" },
    );
    execFileSync(executable, executable === pnpm ? args : [pnpm, ...args], {
      env: process.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    const artifact = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(artifact.dependencies["@example/utils"], "1.2.3");
    validateArtifact(release, artifact);
    const contents = execFileSync("tar", ["-tf", tarball], {
      encoding: "utf8",
    });
    assert.match(contents, /package\/index.js/u);
    assert.doesNotMatch(contents, /packages\/utils/u);
    assert.ok(readFileSync(tarball).length > 0);
    const lintArgs = ["exec", "publint", tarball];
    execFileSync(
      executable,
      executable === pnpm ? lintArgs : [pnpm, ...lintArgs],
      { env: process.env, encoding: "utf8", stdio: "pipe" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata CLI keeps the preset private and requires supported events", () => {
  const command = resolve("scripts", "release.js");
  for (const env of [
    { RELEASE_EVENT: "push", RELEASE_TAG: "core-v0.0.0" },
    { RELEASE_EVENT: "workflow_dispatch", PACKAGE_INPUT: "core" },
    { RELEASE_EVENT: "push", RELEASE_TAG: "unknown-v1.0.0" },
    { RELEASE_EVENT: "pull_request" },
  ]) {
    assert.throws(() =>
      execFileSync(process.execPath, [command, "metadata"], {
        env: { ...process.env, ...env },
        stdio: "pipe",
      }),
    );
  }
});
