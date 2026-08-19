#!/usr/bin/env bash
#
# Cut a release: one command, or it does not happen.
#
# A version lives in three places -- `pyproject.toml`, `VERSION` in `web/build.js`, and the
# `BUILD` stamp beside it -- and a release that moves two of them looks exactly like a fix
# that was never shipped: the pod runs the new code and the node paints the old number.
# That has happened, so the bump is no longer typed by hand.
#
#   tools/release.sh 0.14.2 notes.md     # notes become the annotated tag's message
#   tools/release.sh 0.14.2 notes.md --retag   # move a tag already pushed
#
# The tests are the gate. Nothing is committed, tagged or pushed unless all four suites
# pass, which is the only way the version guard in tests/test_version.py can protect
# anything.
set -euo pipefail

cd "$(dirname "$0")/.."

version="${1:-}"
notes="${2:-}"
retag=""
for arg in "$@"; do [ "$arg" = "--retag" ] && retag=1; done

[ -n "$version" ] || { echo "usage: tools/release.sh <version> [notes-file] [--retag]" >&2; exit 2; }
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || { echo "release: '$version' is not x.y.z" >&2; exit 2; }

tag="v$version"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || { echo "release: on '$branch', releases are cut from main" >&2; exit 1; }

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null && [ -z "$retag" ]; then
    echo "release: $tag exists -- pass --retag to move it" >&2; exit 1
fi

# The one file the author writes. Without it the tag would say only its own number, which
# is what `git log` already says.
if [ -n "$notes" ]; then
    [ -f "$notes" ] || { echo "release: no notes file at $notes" >&2; exit 2; }
    message=$(printf '%s\n\n%s\n' "$version" "$(cat "$notes")")
else
    message="$version"
fi

stamp=$(date +"%Y-%m-%d·%H:%M")
echo "release: $tag  build $stamp"

# --- the three places, moved together ------------------------------------------------
python3 - "$version" "$stamp" <<'PY'
import re, sys
version, stamp = sys.argv[1], sys.argv[2]

def swap(path, pattern, replacement):
    text = open(path, encoding="utf-8").read()
    new, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        raise SystemExit(f"release: could not find the version line in {path}")
    open(path, "w", encoding="utf-8").write(new)

swap("pyproject.toml", r'^version = ".*"$', f'version = "{version}"')
swap("web/build.js", r'^export const VERSION = ".*";$', f'export const VERSION = "{version}";')
swap("web/build.js", r'^export const BUILD = ".*";$', f'export const BUILD = "{stamp}";')
PY

# The public workflow stamps the version on our three nodes, so it moves with the bump. It is
# generated from the-project's copy; without that checkout there is nothing to regenerate from,
# and the stamp simply stays where it was rather than failing the release.
source="$HOME/Projects/experiments/the-project/comfyui/examples/video-minimaxh3/minimaxh3-director.json"
if [ -f "$source" ]; then
    python3 tools/sync_workflow.py
else
    echo "release: no the-project checkout -- examples/minimax-director.json left as it is" >&2
fi

# --- the gate --------------------------------------------------------------------------
COMFYUI_PATH="${COMFYUI_PATH:-$HOME/dev/ComfyUI}"
python="$COMFYUI_PATH/.venv/bin/python"
[ -x "$python" ] || python=python3

echo "release: pytest"
"$python" -m pytest tests -q --ignore=tests/graph
echo "release: graph tests"
COMFYUI_PATH="$COMFYUI_PATH" "$python" -m pytest tests/graph -q
echo "release: node tests"
node --test tests/js/*.mjs >/dev/null
echo "release: loadcheck"
./tools/loadcheck.sh >/dev/null

# --- commit, tag, push ------------------------------------------------------------------
git add pyproject.toml web/build.js examples/minimax-director.json
git commit -q -m "$version"
git tag ${retag:+-f} -a "$tag" -m "$message"

remote=$(git remote get-url origin)
if [ -f "$HOME/Projects/experiments/the-project/.env" ]; then
    # SSH on this account belongs to a different GitHub user, so the push uses the PAT the
    # rest of the toolchain uses. Never echoed: the URL carries it.
    token=$(grep -m1 '^IMBUTUS_GH_TOKEN=' "$HOME/Projects/experiments/the-project/.env" | cut -d= -f2-)
    [ -n "$token" ] && remote="https://x-access-token:${token}@github.com/imbutus/ComfyUI-MiniMaxDirector.git"
fi

git push "$remote" main 2>&1 | sed "s/${token:-__none__}/***/g"
git push ${retag:+-f} "$remote" "$tag" 2>&1 | sed "s/${token:-__none__}/***/g"

# The push went to a URL rather than to `origin`, so the remote-tracking ref did not
# move and `git status` starts saying the upstream is gone. One fetch puts it back.
git fetch -q origin
git branch -q --set-upstream-to=origin/main main 2>/dev/null || true

echo "release: $tag pushed"
