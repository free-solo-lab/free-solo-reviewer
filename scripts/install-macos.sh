#!/bin/bash
# Installs Reviewer on macOS: Homebrew, Git, Node.js and GitHub CLI when they are missing,
# then builds Reviewer.app from source and puts it into Applications. Run it again to update.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/free-solo-lab/free-solo-reviewer/master/scripts/install-macos.sh)"
#
# REVIEWER_REPO and REVIEWER_SOURCE override the repository and the folder with the sources.
set -euo pipefail

REPO_URL="${REVIEWER_REPO:-https://github.com/free-solo-lab/free-solo-reviewer.git}"
SOURCE_DIR="${REVIEWER_SOURCE:-$HOME/Library/Application Support/Reviewer/source}"

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}
brew_env() {
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$brew" ]; then
      eval "$("$brew" shellenv)"
      return
    fi
  done
}
node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&b>=13)?0:1)'
}

[ "$(uname -s)" = Darwin ] || fail "This installer is for macOS."
[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 0 ] ||
  fail 'Terminal runs under Rosetta. Turn off "Open using Rosetta" for Terminal and try again.'
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)." ;;
esac

command -v brew >/dev/null || brew_env
if ! command -v brew >/dev/null; then
  step "Installing Homebrew — it asks for your Mac password"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew_env
fi
command -v brew >/dev/null || fail "Homebrew is not available. Install it from https://brew.sh and run this again."

missing=()
# On a clean Mac /usr/bin/git is only a stub that asks to install the developer tools.
{ command -v git >/dev/null && git --version >/dev/null 2>&1; } || missing+=(git)
command -v gh >/dev/null || missing+=(gh)
node_ok || missing+=(node@24)
if [ ${#missing[@]} -gt 0 ]; then
  step "Installing ${missing[*]}"
  brew install "${missing[@]}"
fi
# node@24 is keg-only: Homebrew does not put it on PATH by itself.
if ! node_ok; then
  PATH="$(brew --prefix node@24)/bin:$PATH"
  export PATH
fi
node_ok || fail "Node.js 24 is not available."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/../package.json" ] && grep -q '"name": "free-solo-reviewer"' "$HERE/../package.json"; then
  SOURCE_DIR="$(cd "$HERE/.." && pwd)"
  step "Using the sources in $SOURCE_DIR"
elif [ -d "$SOURCE_DIR/.git" ]; then
  step "Updating the sources in $SOURCE_DIR"
  git -C "$SOURCE_DIR" pull --ff-only
else
  step "Downloading Reviewer into $SOURCE_DIR"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"
step "Installing dependencies"
npm ci --no-audit --no-fund
step "Building Reviewer.app — this takes a few minutes the first time"
npm run desktop:package

BUILT="$SOURCE_DIR/release/Reviewer-darwin-$ARCH/Reviewer.app"
[ -d "$BUILT" ] || fail "The build did not produce $BUILT."
TARGET_DIR=/Applications
[ -w "$TARGET_DIR" ] || TARGET_DIR="$HOME/Applications"
mkdir -p "$TARGET_DIR"
TARGET="$TARGET_DIR/Reviewer.app"

if pgrep -xq Reviewer; then
  step "Quitting the running Reviewer — unfinished analyses resume after the restart"
  osascript -e 'quit app "Reviewer"' || true
  for _ in $(seq 1 20); do pgrep -xq Reviewer || break; sleep 0.5; done
fi
step "Installing $TARGET"
rm -rf "$TARGET"
ditto "$BUILT" "$TARGET"

open "$TARGET"
cat <<EOF

$(printf '\033[1;32m')Reviewer is installed.$(printf '\033[0m') It is in $TARGET_DIR and in Spotlight.

In the app, press the buttons in the banner at the top:
  1. Sign in to GitHub — confirm the one-time code on github.com.
  2. Connect Codex — sign in with ChatGPT or paste an OpenAI API key.

To update later, run this installer again.
EOF
