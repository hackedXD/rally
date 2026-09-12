#!/usr/bin/env bash
#
# Push the working tree to the box and rebuild. Run from anywhere:
#
#   deploy/deploy.sh root@45.76.12.34
#   RALLY_HOST=root@45.76.12.34 deploy/deploy.sh
#
# Deliberately rsync, not `git pull`: it deploys exactly what is in front of you,
# including changes you have not committed, which is what you want when you are
# chasing a bug that only appears over a real network.

set -euo pipefail

HOST="${1:-${RALLY_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "usage: deploy/deploy.sh user@host   (or set RALLY_HOST)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR=/opt/rally
# The deploy user owns /opt/rally (provision.sh hands it over) but docker still
# needs root unless they are in the docker group, so every compose call goes
# through sudo. Harmless when already root.
DC="sudo docker compose"

echo "==> Syncing $REPO_ROOT -> $HOST:$REMOTE_DIR"
# `.env` is excluded in both directions: the copy on the server is the only copy
# of the production secrets, and rsync leaves excluded files on the receiver
# alone even under --delete.
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'replays' \
  --exclude '.env' \
  --exclude '*.log' \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

echo "==> Building and restarting"
# --build because the image bakes the display and phone bundles; without it a
# front-end change deploys the old bundle and looks like a caching bug.
ssh "$HOST" "cd $REMOTE_DIR/deploy && $DC up -d --build --remove-orphans"

echo "==> Waiting for health"
ssh "$HOST" "cd $REMOTE_DIR/deploy && \
  for i in \$(seq 1 45); do \
    if $DC exec -T rally wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1; then \
      echo 'healthy'; break; \
    fi; \
    sleep 2; \
  done; \
  $DC ps"

DOMAIN="$(ssh "$HOST" "grep -E '^RALLY_DOMAIN=' $REMOTE_DIR/deploy/.env | cut -d= -f2-" || true)"
if [ -n "$DOMAIN" ]; then
  echo
  echo "    https://$DOMAIN"
  echo "    https://$DOMAIN/healthz"
  echo
  echo "The first request takes a few seconds while Caddy gets a certificate."
fi
