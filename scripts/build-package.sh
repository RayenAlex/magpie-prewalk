#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist"
PKG="$OUT/magpie-prewalk-package"
TARBALL="$OUT/magpie-prewalk-package.tgz"
BUN=${BUN:-bun}
"$BUN" build "$ROOT/src/index.ts" --outfile "$PKG/dist/index.hooks.js" --target browser
cp "$ROOT/package.json" "$PKG/package.json"
cat > "$PKG/README.md" <<'EOF'
# magpie-prewalk

Prewalk routing policy plugin. Requires a magpie host with the route-v1 contract.
EOF
tar -czf "$TARBALL" -C "$OUT" magpie-prewalk-package
printf '%s\n' "$TARBALL"
