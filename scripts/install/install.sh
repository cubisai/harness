#!/usr/bin/env bash
# CubiQ installer for macOS (Apple Silicon), Linux and Windows via Git Bash.
#
#   curl -fsSL https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.sh | bash
#   irm https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.ps1 | iex   (Windows PowerShell)
#
# Environment:
#   VERSION          release to install, e.g. 0.1.3 (default: the latest release)
#   INSTALL_DIR      macOS: /Applications (default); Linux: $HOME/.local/bin (default)
#   CUBIQ_NO_LAUNCH  set to 1 to skip launching CubiQ after installing
#   GITHUB_TOKEN     optional GitHub token; anonymous API calls are capped at 60/hour

set -euo pipefail

API_BASE="https://api.github.com/repos/cubisai/harness/releases"

tmp=""
mounted=""
version=""
asset_urls=""
use_sudo=""

log() { printf '==> %s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$mounted" ]; then
    hdiutil detach "$mounted" -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$tmp" ] && [ -d "$tmp" ]; then
    rm -rf "$tmp" || true
  fi
}

# Only set on macOS, when the install dir needs root to write.
privileged() {
  if [ -n "$use_sudo" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

api_get() {
  # The token only matters because the anonymous limit is per IP, and CI/dev
  # machines behind one address run out of it quickly.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$1"
  else
    curl -fsSL "$1"
  fi
}

fetch() {
  curl -fsSL "$1" -o "$2" || die "download failed: $1"
}

pick_asset() {
  # A path-like pattern would otherwise be read as a grep flag.
  printf '%s\n' "$asset_urls" | grep -E -- "$1" | head -n 1 || true
}

print_done() {
  printf 'CubiQ %s installed. It updates itself from now on.\n' "$version"
}

install_macos() {
  local arch
  arch=$(uname -m)
  if [ "$arch" != "arm64" ]; then
    die "only an Apple Silicon (arm64) build is published for macOS; build from source instead: https://github.com/cubisai/harness#build-from-source"
  fi

  local dir="${INSTALL_DIR:-/Applications}"
  local url
  url=$(pick_asset '-arm64\.dmg$')
  [ -n "$url" ] || die "release $version has no macOS arm64 dmg; see https://github.com/cubisai/harness/releases"

  log "Downloading CubiQ ${version}..."
  local dmg="$tmp/${url##*/}"
  fetch "$url" "$dmg"

  log "Mounting ${dmg##*/}..."
  mkdir -p "$tmp/mnt"
  hdiutil attach -nobrowse -readonly -quiet -mountpoint "$tmp/mnt" "$dmg" >/dev/null ||
    die "could not mount ${dmg##*/}"
  mounted="$tmp/mnt"
  [ -d "$tmp/mnt/CubiQ.app" ] || die "CubiQ.app is missing from ${dmg##*/}"

  log "Quitting a running CubiQ..."
  osascript -e 'quit app "CubiQ"' >/dev/null 2>&1 || true
  local waited=0
  while pgrep -x CubiQ >/dev/null 2>&1 && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  pkill -x CubiQ >/dev/null 2>&1 || true

  if [ ! -w "$dir" ]; then
    use_sudo="1"
  fi
  privileged mkdir -p "$dir"

  log "Installing CubiQ.app into ${dir}..."
  privileged rm -rf "$dir/CubiQ.app"
  privileged ditto "$tmp/mnt/CubiQ.app" "$dir/CubiQ.app"
  # Builds are ad-hoc signed and not notarized, so Gatekeeper would block the
  # first launch while the quarantine flag is set.
  privileged xattr -dr com.apple.quarantine "$dir/CubiQ.app" >/dev/null 2>&1 || true

  if [ "${CUBIQ_NO_LAUNCH:-}" != "1" ]; then
    open "$dir/CubiQ.app"
  fi
  print_done
}

install_windows() {
  local url
  url=$(pick_asset 'CubiQ-Setup-.*\.exe$')
  [ -n "$url" ] || die "release $version has no Windows installer (CubiQ-Setup-*.exe); see https://github.com/cubisai/harness/releases"

  log "Downloading CubiQ ${version}..."
  local exe="$tmp/${url##*/}"
  fetch "$url" "$exe"

  log "Stopping a running CubiQ..."
  taskkill //IM CubiQ.exe //F >/dev/null 2>&1 || true

  log "Running the installer..."
  # Git Bash rewrites arguments that look like paths, so /S needs the guard or
  # NSIS sees a mangled path instead of the silent flag.
  MSYS_NO_PATHCONV=1 "$exe" /S || die "installer failed"

  local app="${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/CubiQ/CubiQ.exe"
  if [ "${CUBIQ_NO_LAUNCH:-}" != "1" ] && [ -f "$app" ]; then
    nohup "$app" >/dev/null 2>&1 &
  fi
  print_done
}

install_linux() {
  local dir="${INSTALL_DIR:-$HOME/.local/bin}"
  local url
  url=$(pick_asset '\.AppImage$')
  [ -n "$url" ] || die "release $version has no Linux AppImage; see https://github.com/cubisai/harness/releases"

  log "Downloading CubiQ ${version}..."
  mkdir -p "$dir"
  # Download beside, then move: a running AppImage keeps its old file.
  fetch "$url" "$tmp/cubiq"
  chmod +x "$tmp/cubiq"
  mv -f "$tmp/cubiq" "$dir/cubiq"

  printf 'Run CubiQ with: %s\n' "$dir/cubiq"
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) printf 'warning: %s is not on your PATH; use the full path above.\n' "$dir" ;;
  esac

  print_done
}

main() {
  local os
  case "$(uname -s)" in
    Darwin) os="macos" ;;
    Linux) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) os="windows" ;;
    *)
      die "unsupported operating system: $(uname -s); build from source instead: https://github.com/cubisai/harness#build-from-source"
      ;;
  esac

  tmp=$(mktemp -d)
  trap cleanup EXIT

  local api_url
  if [ -n "${VERSION:-}" ]; then
    local pinned="${VERSION#cubiq-v}"
    api_url="$API_BASE/tags/cubiq-v${pinned#v}"
  else
    api_url="$API_BASE/latest"
  fi

  log "Looking up CubiQ release metadata..."
  api_get "$api_url" >"$tmp/release.json" ||
    die "could not read $api_url (has a release been published yet?)"

  version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"cubiq-v\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)
  [ -n "$version" ] || die "no cubiq-v* release found at $api_url"

  asset_urls=$(grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' "$tmp/release.json" |
    sed -e 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"//' -e 's/"$//') || true

  case "$os" in
    macos) install_macos ;;
    windows) install_windows ;;
    linux) install_linux ;;
  esac
}

# Defined last so a truncated `curl | bash` download exits before doing anything.
main "$@"
