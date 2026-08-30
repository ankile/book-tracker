#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MERMAID_CLI_VERSION="11.16.0"

if [[ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ]]; then
  CHROME_BIN="${PUPPETEER_EXECUTABLE_PATH}"
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
else
  echo "Chrome or Chromium was not found. Set PUPPETEER_EXECUTABLE_PATH." >&2
  exit 1
fi

cd "${REPO_ROOT}"
export PUPPETEER_EXECUTABLE_PATH="${CHROME_BIN}"

render_diagram() {
  local stem="$1"
  local width="$2"
  npm exec --yes --package "@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}" -- \
    mmdc -i "docs/architecture/${stem}.mmd" \
    -o "docs/architecture/${stem}.svg" \
    -c "docs/architecture/mermaid-config.json" \
    -C "docs/architecture/mermaid.css" \
    -b transparent -w "${width}"
  npm exec --yes --package "@mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION}" -- \
    mmdc -i "docs/architecture/${stem}.mmd" \
    -o "docs/architecture/${stem}.png" \
    -c "docs/architecture/mermaid-config.json" \
    -C "docs/architecture/mermaid.css" \
    -b white -w "${width}" -s 2
}

render_diagram system-context 1600
render_diagram app-architecture 2200
render_diagram backend-runtime 2000
render_diagram site-functionality 1800

node docs/architecture/site-access.ts
"${CHROME_BIN}" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --window-size=1600,1200 \
  --screenshot="${REPO_ROOT}/docs/architecture/site-access.png" \
  "file://${REPO_ROOT}/docs/architecture/site-access.svg" \
  >/dev/null 2>&1

node docs/architecture/verify.ts
