// Can Pi actually LOAD what we ship?
//
// This test exists because a duplicate top-level `function readPreferredWindow()` in index.ts shipped and
// killed the whole extension: Pi loads index.ts as an ES module, where redeclaring a top-level function is a
// SyntaxError, so /chrome and every chrome_* tool disappeared from the session. Every other harness slices
// *sections* of the source into sloppy-mode `vm` scripts, where duplicate function declarations are legal —
// so nothing caught it. These checks parse the two files exactly the way their real loaders see them:
// index.ts as a strict ES module, service_worker.js as a classic script.
//
// Cheap on purpose: no imports, no sandbox, no browser. A file that cannot parse cannot work.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const indexSource = fs.readFileSync(path.join(root, "extensions/chrome-profile-bridge/index.ts"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "extensions/chrome-profile-bridge/browser-extension/service_worker.js"), "utf8");

// The check itself lives in scripts/check-extension-load.mjs, which deploy.sh runs before copying index.ts
// into the live install — one implementation, so the repo and the deploy path can never disagree about
// whether a build is loadable.
const loadCheck = path.join(root, "scripts/check-extension-load.mjs");

function runLoadCheck(sourcePath) {
  return spawnSync(process.execPath, [loadCheck, sourcePath], { encoding: "utf8" });
}

test("index.ts parses as the ES module Pi loads it as", () => {
  const result = runLoadCheck(path.join(root, "extensions/chrome-profile-bridge/index.ts"));
  assert.equal(result.status, 0, `index.ts does not parse as an ES module:
${result.stderr || result.stdout}`);
  assert.match(result.stdout, /parses as an ES module/);
});

test("index.ts declares no top-level name twice", () => {
  // The bug in one assertion, with a message that names the offender instead of a parser offset. Pi loads
  // this file as a module, so a repeated function/const declaration is fatal — unlike the sloppy-mode
  // section harnesses, which quietly take the last one.
  const names = new Map();
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*[:=]/gm;
  for (const match of indexSource.matchAll(declaration)) {
    const name = match[1] ?? match[2];
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const duplicated = [...names].filter(([, count]) => count > 1).map(([name]) => name);
  assert.deepEqual(duplicated, [], `top-level declarations repeated (fatal when loaded as a module): ${duplicated.join(", ")}`);
});

test("service_worker.js parses as the classic script the browser runs", () => {
  // chrome's extension loader does not run this in module mode, so a script-mode compile is the faithful check.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chrome-load-"));
  const file = path.join(dir, "service_worker.js");
  try {
    fs.writeFileSync(file, workerSource);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `service_worker.js does not parse:\n${result.stderr || result.stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Pi-side file that /chrome lives in is in the deployed set", () => {
  // The command and the tools are registered from index.ts. If it ever leaves deploy.sh's copy list, the
  // live install keeps an older surface while the tests pass against the repo — the same class of drift
  // that makes a fix look deployed when it is not.
  const deploy = fs.readFileSync(path.join(root, "deploy.sh"), "utf8");
  assert.match(deploy, /"extensions\/chrome-profile-bridge\/index\.ts"/, "deploy.sh must copy index.ts");
});
