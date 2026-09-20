// Does the Pi-side extension file actually LOAD?
//
// Pi imports extensions/chrome-profile-bridge/index.ts as an ES module. In a module, a duplicate
// top-level declaration is a SyntaxError — and it takes the whole extension with it: /chrome, every
// chrome_* tool, and the bridge they talk to simply never register. That shipped once (a repeated
// `function readPreferredWindow()`), and the unit harnesses could not see it because they slice
// *sections* of the source into sloppy-mode vm scripts, where redeclaring a function is legal.
//
// So this checks the file the way its real loader does: strip the TypeScript (mode "transform", because
// the file uses parameter properties that strip-only mode rejects), then compile the result as an ES
// module with `node --check`. Usage:
//
//   node scripts/check-extension-load.mjs [index.ts] [outfile.mjs]
//
// Exits non-zero with the parser's message when the file cannot be loaded. deploy.sh runs this before
// copying index.ts into the live install; test-suite/unit/extension-load.test.mjs runs it too, so the
// repo and the deploy path can never disagree about whether a build is loadable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? path.resolve(here, "../extensions/chrome-profile-bridge/index.ts");
const outFile = process.argv[3];
const label = path.relative(process.cwd(), source) || source;

let stripped;
try {
  stripped = stripTypeScriptTypes(fs.readFileSync(source, "utf8"), { mode: "transform" });
} catch (error) {
  console.error(`ERROR: ${label} could not be type-stripped: ${error.message}`);
  process.exit(1);
}

// A private file (never imported): node --check only parses it, and the .mjs extension is what makes
// node treat it as a module rather than a script.
const tempDir = outFile ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "pi-chrome-load-"));
const target = outFile ?? path.join(tempDir, "candidate.mjs");
try {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, stripped);
  const result = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`ERROR: ${label} does not parse as an ES module (Pi could not load the extension):`);
    console.error((result.stderr || result.stdout || "").trim());
    process.exit(1);
  }
} finally {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
console.log(`ok: ${label} parses as an ES module`);
