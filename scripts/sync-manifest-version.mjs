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
// "0.15.51-aufa.1" is rejected outright and the extension fails to load, so fail loudly here
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

const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw);
if (manifest.version === version) {
  console.log(`manifest.json already in sync at ${version}`);
} else {
  const before = manifest.version;
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json version ${before} -> ${version}`);
}
