#!/usr/bin/env bash
# Roll back OnePick to the image captured immediately before the non-root security release.
set -euo pipefail
cd /opt/docker/onepick
old_image="$(cat data/rollback-image-pre-security.txt)"
docker tag "$old_image" onepick-onepick-tools:latest
docker compose up -d --force-recreate --no-deps onepick-tools
chown -R root:root data cookies
find data cookies -type d -exec chmod 755 {} +
find data cookies -type f -exec chmod 600 {} +
echo "Rolled back to $old_image"
