#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/magpie-prewalk-provider"
rm -rf "$OUT"
mkdir -p "$OUT/provider"
cp "$ROOT/src/provider/index.ts" "$ROOT/src/provider/internals.ts" \
	"$ROOT/src/provider/state.ts" "$ROOT/src/provider/store.ts" \
	"$ROOT/src/provider/classifier.ts" "$ROOT/src/provider/handoff.ts" \
	"$ROOT/src/provider/prompts.ts" "$OUT/provider/"
# The policy, history and judgment modules are shared with the route plugin;
# the provider package ships the same source it imports.
cp "$ROOT/src/history.ts" "$ROOT/src/policy.ts" "$ROOT/src/judgment.ts" "$OUT/"
cp "$ROOT/src/provider/package.json" "$ROOT/src/provider/README.md" "$OUT/"
cp -R "$ROOT/src/provider/page" "$OUT/page"
printf '%s\n' "$OUT"
