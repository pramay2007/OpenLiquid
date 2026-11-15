#!/bin/sh
# Build the web app against the Arc testnet deployment and publish it to the gh-pages branch,
# which GitHub Pages serves. The branch holds only the built site and is replaced on each run.
#
#   npm run publish:web
#   VITE_KEEPER_URL=https://my-keeper.example npm run publish:web
set -e
cd "$(dirname "$0")/.."

: "${VITE_KEEPER_URL:=https://openliquid-keeper.onrender.com}"
remote=$(git remote get-url origin)

VITE_NETWORK=arcTestnet VITE_KEEPER_URL="$VITE_KEEPER_URL" npm --prefix web run build
touch web/dist/.nojekyll

tmp=$(mktemp -d)
cp -R web/dist/. "$tmp"
cd "$tmp"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" \
  commit -qm "Publish web app (keeper: $VITE_KEEPER_URL)"
git push -f "$remote" gh-pages
rm -rf "$tmp"
echo "published; keeper URL baked in: $VITE_KEEPER_URL"
