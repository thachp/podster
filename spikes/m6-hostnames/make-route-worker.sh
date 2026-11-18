#!/usr/bin/env bash
# Spike D's test Worker on the content zone, by the owner's yes of 2026-11-18. Deploys or deletes one Worker named
# spike-hostnames-route-<random>, routed */* on podster.site, with no bindings and workers.dev off.
#
#   make-route-worker.sh deploy <dir>   writes the Worker, its config and its key into <dir> (a scratch folder
#                                        outside the repository), and deploys it
#   make-route-worker.sh delete <dir>   deletes the Worker named in <dir>, and its route with it
#
# It uses wrangler's own login, as staging deploys do, and the staging account's ID from the owner's file, which it
# never prints. Wrangler's output is passed through a filter that hides 32-hex IDs.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
wrangler="$here/../../apps/gateway/node_modules/.bin/wrangler"
cmd="${1:-}"
dir="${2:-}"
[ -n "$dir" ] || { echo "usage: $0 deploy|delete <scratch dir>" >&2; exit 2; }
# Resolve <dir> to an absolute path first, so a relative path can't pass the outside-the-repository check.
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
parent="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P)" || { echo "refusing: <dir>'s parent folder must exist" >&2; exit 2; }
dir="$parent/$(basename "$dir")"
repo="$(cd "$here/../.." && pwd -P)"
case "$dir/" in "$repo/"*) echo "refusing: <dir> must be outside the repository" >&2; exit 2;; esac
redact() { sed -E 's/[0-9a-f]{32}/<id>/g; s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g'; }
run_wrangler() {
  (cd "$dir" && env -u CLOUDFLARE_API_TOKEN CI=true \
    CLOUDFLARE_ACCOUNT_ID="$(tr -d '\n ' < "$HOME/.podster/cloudflare-account-id.staging")" \
    "$wrangler" "$@") 2>&1 | redact
}

case "$cmd" in
  deploy)
    mkdir -p "$dir" && chmod 700 "$dir"
    [ -e "$dir/name" ] && { echo "refusing: $dir already holds a Worker" >&2; exit 2; }
    name="spike-hostnames-route-$(openssl rand -hex 3)"
    [[ "$name" =~ ^spike-hostnames-route-[0-9a-f]{6}$ ]] || exit 2
    (umask 077 && openssl rand -hex 24 > "$dir/key")
    printf '%s\n' "$name" > "$dir/name"
    sed "s/__KEY__/$(cat "$dir/key")/" "$here/route-worker.mjs" > "$dir/worker.mjs"
    cat > "$dir/wrangler.jsonc" <<EOF
{
  "name": "$name",
  "main": "worker.mjs",
  "compatibility_date": "2026-11-01",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "*/*", "zone_name": "podster.site" }]
}
EOF
    echo "deploying $name"
    run_wrangler deploy
    ;;
  delete)
    name="$(cat "$dir/name")"
    [[ "$name" =~ ^spike-hostnames-route-[0-9a-f]{6}$ ]] || { echo "refusing: not a spike Worker's name" >&2; exit 2; }
    echo "deleting $name"
    run_wrangler delete --name "$name" --force
    ;;
  *) echo "usage: $0 deploy|delete <scratch dir>" >&2; exit 2 ;;
esac
