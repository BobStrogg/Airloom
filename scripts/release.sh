#!/usr/bin/env bash
set -euo pipefail

# Interactive release script for Airloom.
#
# Usage: ./scripts/release.sh
#
# Prompts you to choose patch / minor / major with a preview,
# then commits, tags, and pushes automatically.
# The GitHub Actions workflow publishes to npm when the tag lands.

# Ensure we're at the repo root
cd "$(git rev-parse --show-toplevel)"

# Ensure clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Read current version
CURRENT=$(node -p "require('./apps/host/package.json').version")

# Compute previews for each bump type
read -r V_PATCH V_MINOR V_MAJOR < <(node -e "
  const [ma,mi,pa] = '${CURRENT}'.split('.').map(Number);
  console.log([ma,mi,pa+1].join('.'), [ma,mi+1,0].join('.'), [ma+1,0,0].join('.'));
")

echo ""
echo "Current version: ${CURRENT}"
echo ""
echo "  1) patch  → ${V_PATCH}"
echo "  2) minor  → ${V_MINOR}"
echo "  3) major  → ${V_MAJOR}"
echo ""
read -rp "Choose bump type [1/2/3]: " CHOICE

case "$CHOICE" in
  1|patch)  BUMP="patch";  NEW_VERSION="v${V_PATCH}" ;;
  2|minor)  BUMP="minor";  NEW_VERSION="v${V_MINOR}" ;;
  3|major)  BUMP="major";  NEW_VERSION="v${V_MAJOR}" ;;
  *)        echo "Cancelled."; exit 1 ;;
esac

echo ""
echo "Bumping ${CURRENT} → ${NEW_VERSION}"

# Apply the bump
cd apps/host
npm version "$BUMP" --no-git-tag-version > /dev/null
cd ../..

# Commit, tag, push
git add apps/host/package.json
git commit -m "${NEW_VERSION}"
git tag "${NEW_VERSION}"
git push
git push --tags

echo ""
echo "Pushed ${NEW_VERSION} — GitHub Actions will publish to npm."
