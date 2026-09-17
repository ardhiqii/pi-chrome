#!/usr/bin/env bash
# Deploy this fork's pi-chrome build into the live unpacked extension install.
#
# - Copies ONLY the files this build changes: the extension service worker, the Pi-side tool
#   surface, and the two files carrying this build's version (package.json / manifest.json).
# - Refuses to overwrite a live install whose package.json version is neither $BASE_VERSION (this
#   build) nor $BASE_VERSION_UPSTREAM (a clean upstream reinstall), or whose service_worker.js is
#   neither a known-good base (pristine release or page-target-fixed) nor an already-deployed
#   fork build. --force overrides the refusal (a backup is still made).
# - Backs up each overwritten file with a .pi-backup-<timestamp> suffix first.
# - Idempotent: identical files are skipped, so a second run copies nothing.
# - Never moves, reinstalls, or re-adds the extension: the install path is unchanged.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${PI_CHROME_INSTALL_DIR:-$HOME/.pi/agent/npm/node_modules/pi-chrome}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# This build's version, and the upstream release it was based on. Both are accepted as the live
# install's package.json version:
#   - BASE_VERSION: this local build. The 4th integer keeps it newer than upstream 0.15.51 while
#     still sorting BELOW a future 0.15.52, so upstream upgrades still win the comparison.
#   - BASE_VERSION_UPSTREAM: a clean upstream reinstall (pristine 0.15.51).
# Two service_worker.js sha256 values are accepted as a known-good content base:
#   - BASE_SW_SHA256: the pristine 0.15.51 file (git import 6c7b3b2),
#   - PATCHED_BASE_SW_SHA256: 0.15.51 after the pre-existing local page-target attach fix
#     (b801936), the file the earlier review verified.
# A clean reinstall ships the pristine file, so accepting only the patched hash would refuse it and
# force the owner to pass --force on a perfectly safe deploy.
BASE_VERSION="0.15.51.1"
BASE_VERSION_UPSTREAM="0.15.51"
BASE_SW_SHA256="ac1e346d88aaa684d1998b17f899c4b50077d27f01eeb1a3393649013643ee3f"
PATCHED_BASE_SW_SHA256="a5b2cdd816c357acd3910aa6f24db7ac61ec0684851d12013be5e50664dfc764"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "usage: bash deploy.sh [--force]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "usage: bash deploy.sh [--force]" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$DEST_ROOT/extensions/chrome-profile-bridge" ]; then
  echo "ERROR: live pi-chrome install not found at: $DEST_ROOT" >&2
  echo "Override it with: PI_CHROME_INSTALL_DIR=/path/to/pi-chrome bash deploy.sh" >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo ""
  fi
}

# ---- upgrade guard -----------------------------------------------------------
# After `npm/pi update`, the live install is a newer release while this build still carries
# 0.15.51 files. Copying them in would leave a version-skewed install: package.json / manifest.json
# (not copied) would keep reporting the newer version, the extension's own version-skew auto-reload
# check could not see the mismatch, and the downgraded service_worker.js would silently win.
src_sw="$SRC/extensions/chrome-profile-bridge/browser-extension/service_worker.js"
dest_sw="$DEST_ROOT/extensions/chrome-profile-bridge/browser-extension/service_worker.js"
dest_version=""
if [ -f "$DEST_ROOT/package.json" ]; then
  dest_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST_ROOT/package.json" | head -n 1)"
fi
dest_sw_sha=""
if [ -f "$dest_sw" ]; then
  dest_sw_sha="$(sha256_of "$dest_sw")"
fi
# A fork build marks itself with "FORK BUILD" so this guard can recognise an already-deployed copy.
# The legacy "LOCAL/PRIVATE build" string is accepted too: installs deployed before the marker was
# renamed still carry it, and refusing those would force --force on a perfectly safe re-deploy.
dest_sw_is_fork_build=0
if [ -f "$dest_sw" ] && grep -qE "FORK BUILD|LOCAL/PRIVATE build" "$dest_sw" 2>/dev/null; then
  dest_sw_is_fork_build=1
fi
dest_sw_is_known_base=0
if [ -n "$dest_sw_sha" ] && { [ "$dest_sw_sha" = "$BASE_SW_SHA256" ] || [ "$dest_sw_sha" = "$PATCHED_BASE_SW_SHA256" ]; }; then
  dest_sw_is_known_base=1
fi
if [ "$FORCE" -ne 1 ]; then
  if [ -n "$dest_version" ] && [ "$dest_version" != "$BASE_VERSION" ] && [ "$dest_version" != "$BASE_VERSION_UPSTREAM" ]; then
    echo "ERROR: live install is version $dest_version, but this build is $BASE_VERSION" >&2
    echo "       (based on $BASE_VERSION_UPSTREAM). Deploying would mix versions of the extension" >&2
    echo "       service worker and its manifests. Re-run with --force only if you deliberately" >&2
    echo "       want to keep this local build on top of that release." >&2
    exit 1
  fi
  if [ -n "$dest_sw_sha" ] && [ "$dest_sw_is_known_base" -ne 1 ] && [ "$dest_sw_is_fork_build" -ne 1 ] && ! cmp -s "$src_sw" "$dest_sw"; then
    echo "ERROR: $dest_sw" >&2
    echo "       is neither a known $BASE_VERSION_UPSTREAM base (sha256 ${BASE_SW_SHA256:0:12}... pristine or" >&2
    echo "       ${PATCHED_BASE_SW_SHA256:0:12}... with the fork's page-target fix) nor an" >&2
    echo "       already-deployed build of this fork." >&2
    echo "       Refusing to guess what it is; re-run with --force to overwrite it anyway." >&2
    exit 1
  fi
fi
if [ "$FORCE" -eq 1 ] && [ -n "$dest_sw_sha" ] && [ "$dest_sw_is_known_base" -ne 1 ] && [ "$dest_sw_is_fork_build" -ne 1 ]; then
  echo "note: --force is overwriting a service_worker.js that is not a known $BASE_VERSION_UPSTREAM base."
fi
if [ -f "$dest_sw" ] && [ -z "$dest_sw_sha" ]; then
  echo "note: no sha256 tool found; base verification is limited to the package.json version."
fi

# Refuse to deploy a broken extension file.
if command -v node >/dev/null 2>&1; then
  if ! node --check "$src_sw"; then
    echo "ERROR: service_worker.js failed 'node --check'; refusing to touch the live install." >&2
    exit 1
  fi
else
  echo "note: node not found on PATH; skipping the syntax pre-check."
fi

REL_FILES=(
  "extensions/chrome-profile-bridge/browser-extension/service_worker.js"
  "extensions/chrome-profile-bridge/index.ts"
  # The version manifests. index.ts re-reads package.json on every /next and advertises it as
  # x-pi-chrome-version; the extension compares that against chrome.runtime.getManifest().version
  # and reloads itself when the manifest is older. Copying BOTH keeps the two in lockstep, and is
  # what lets a deploy pick itself up without a manual Reload at edge://extensions. They must never
  # drift apart in the live install: package.json ahead of manifest.json would make the extension
  # reload on every poll.
  "package.json"
  "extensions/chrome-profile-bridge/browser-extension/manifest.json"
)

changed=0
sw_changed=0
index_changed=0
for rel in "${REL_FILES[@]}"; do
  src="$SRC/$rel"
  dest="$DEST_ROOT/$rel"
  if [ ! -f "$src" ]; then
    echo "ERROR: missing source file: $src" >&2
    exit 1
  fi
  if [ ! -d "$(dirname "$dest")" ]; then
    echo "ERROR: missing destination directory: $(dirname "$dest")" >&2
    exit 1
  fi

  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    echo "up to date : $rel"
    continue
  fi

  if [ -f "$dest" ]; then
    # Keep backups unique even if deploy.sh runs twice within the same second.
    backup="$dest.pi-backup-$STAMP"
    n=1
    while [ -e "$backup" ]; do
      backup="$dest.pi-backup-$STAMP-$n"
      n=$((n + 1))
    done
    cp -p "$dest" "$backup"
    echo "backed up  : $rel -> $(basename "$backup")"
  fi
  cp "$src" "$dest"
  changed=$((changed + 1))
  case "$rel" in
    *service_worker.js) sw_changed=1 ;;
    */index.ts) index_changed=1 ;;
  esac
  echo "deployed   : $rel"
done

echo
if [ "$changed" -eq 0 ]; then
  echo "Nothing copied: the live install already matches this build ($DEST_ROOT)."
else
  echo "Copied $changed file(s) into: $DEST_ROOT"
fi

echo
echo "NEXT STEPS"
echo
if [ "$sw_changed" -eq 1 ]; then
  echo "  1) RELOAD THE EXTENSION (service_worker.js changed):"
  echo "       - open  edge://extensions"
  echo "       - find  \"Pi Chrome Connector\""
  echo "       - click the Reload (circular arrow) button on its card"
  echo "     Extension code cannot hot-reload: without this the old service worker keeps"
  echo "     running and none of the new code executes."
else
  echo "  1) No Reload needed: service_worker.js is unchanged."
  echo "     (A version bump on its own is picked up by the extension's own version-skew"
  echo "     reload; with no version change there is nothing for the browser to reload.)"
fi
echo
if [ "$index_changed" -eq 1 ]; then
  echo "  2) RUN /reload IN PI (index.ts changed):"
  echo "     The Pi-side tool surface only re-registers on /reload."
else
  echo "  2) No /reload needed: index.ts is unchanged."
fi
echo
echo "  If Pi reports that Chrome control is locked, run:  /chrome authorize"
echo
