#!/usr/bin/env node
// Keep the unpacked extension manifest's version in lockstep with package.json.
//
// Why this exists: extensions/chrome-profile-bridge/index.ts re-reads package.json on every /next
// and advertises it to the extension as `x-pi-chrome-version`. service_worker.js compares that
// against `chrome.runtime.getManifest().version` and calls `chrome.runtime.reload()` whenever the
// manifest is older. If package.json were left permanently ahead of manifest.json, the extension
// would reload itself on every single poll. Wired to `npm version` and `prepublishOnly` so the two
// files can never drift. (This exact drift shipped once upstream at 0.14.3 and caused spurious
// /chrome doctor version-mismatch warnings.)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const manifestPath = join(
  root,
  "extensions",
  "chrome-profile-bridge",
  "browser-extension",
  "manifest.json",
);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json has no usable \"version\" field");
}

// Chrome only accepts 1-4 dot-separated integers here. A semver prerelease such as
// "0.15.51-plus.23" is rejected outright and the extension fails to load, so fail loudly here
// instead of shipping a manifest Edge will refuse.
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(
    `package.json version "${version}" is not a valid Chrome extension version.\n` +
      "Chrome requires 1-4 dot-separated integers (e.g. 0.15.51 or 0.15.51.1); " +
      "prerelease suffixes are not allowed.",
  );
}
const parts = version.split(".");
if (parts.every((p) => Number(p) === 0)) {
  throw new Error(`version "${version}" must not be all zero`);
}
for (const part of parts) {
  if (Number(part) > 65535) {
    throw new Error(`version part "${part}" exceeds the 65535 limit`);
  }
  if (part.length > 1 && part.startsWith("0")) {
    throw new Error(`version part "${part}" must not start with a zero`);
  }
}

// Derive the fork's display tag. Chrome validates manifest.version as integers only, so a fork
// marker cannot live there; it lives in version_name (display-only), and this script is what keeps
// the tag from lagging the build. It drifted exactly once: the numeric version reached 0.15.51.22
// while version_name sat at 0.15.51-aufa.21, so the browser and every version report disagreed
// about which fork build was running. Scheme: <major>.<minor>.<patch>-plus.<build>, where build is
// the 4th numeric component (0.15.51.23 -> 0.15.51-plus.23). A 3-component version is padded to
// three so the tag is always well-formed.
const padded = parts.length >= 3 ? parts : [...parts, ...Array(3 - parts.length).fill("0")];
const build = parts[3] ?? "0";
const versionName = `${padded[0]}.${padded[1]}.${padded[2]}-plus.${build}`;

const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw);
const changes = [];
if (manifest.version !== version) {
  changes.push(`version ${manifest.version} -> ${version}`);
}
if (manifest.version_name !== versionName) {
  changes.push(`version_name ${manifest.version_name ?? "(none)"} -> ${versionName}`);
}
if (changes.length === 0) {
  console.log(`manifest.json already in sync at ${version} (${versionName})`);
} else {
  manifest.version = version;
  manifest.version_name = versionName;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json ${changes.join("; ")}`);
}
