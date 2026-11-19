#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MAGPIE=${MAGPIE_SRC:-$(CDPATH= cd -- "$ROOT/../magpie" && pwd)}

if [ -n "${GO_BIN:-}" ]; then
	GO=$GO_BIN
elif command -v go >/dev/null 2>&1; then
	GO=go
else
	echo "no Go toolchain; set GO_BIN" >&2
	exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The gateway test runs plugins on Bun >= 1.4.2; prefer an explicit dir.
if [ -n "${BUN_DIR:-}" ]; then
	PATH="$BUN_DIR:$PATH"
	export PATH
fi

sh "$ROOT/scripts/build-provider-package.sh" >/dev/null

python3 - "$TMP/overlay.json" "$MAGPIE" "$ROOT" <<'PY'
import json
import sys

out, magpie, root = sys.argv[1:4]
overlay = {
    "Replace": {
        magpie + "/internal/gateway/prewalk_provider_integration_test.go":
            root + "/tests/provider/gateway_integration_test.go"
    }
}
with open(out, "w", encoding="utf-8") as handle:
    json.dump(overlay, handle)
PY

cd "$MAGPIE"
PREWALK_PROJECT_ROOT="$ROOT" GOTOOLCHAIN=local GOPROXY=off \
	"$GO" test -tags nogui -count=1 -overlay "$TMP/overlay.json" \
	./internal/gateway -run '^TestProviderPackage' -v
