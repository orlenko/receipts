#!/usr/bin/env bash
# Deploy the site to Cloudflare Pages.
#
# After the one-time CF Pages setup (see HOW_TO_DEPLOY.md), "deploy" just means
# "push to the production branch." CF builds and ships in ~30 seconds. This
# wrapper runs a couple of pre-flight checks so a typo can't take the site down.
#
# Usage: ./scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ node --check on all JS modules"
for f in app.js warp.js db.js batch.js; do
  node --check "$f"
done
echo "  ok"

if [ -z "$(git status --porcelain)" ]; then
  echo "→ nothing to commit, pushing current HEAD"
else
  echo "→ uncommitted changes present — commit first, then rerun:"
  git status --short
  exit 1
fi

branch="$(git symbolic-ref --short HEAD)"
echo "→ pushing $branch to origin"
git push origin "$branch"

echo
echo "✓ pushed. Watch the build at:"
echo "  https://dash.cloudflare.com/?to=/:account/pages/view/receipts"
