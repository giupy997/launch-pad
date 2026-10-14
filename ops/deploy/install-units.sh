#!/bin/bash
# Installs, or updates, the two services of the VPS — the watch (ops/watch.mjs)
# and the points service (points/service.ts) — each as its own system user,
# sandboxed (SECURITY.md, L-02), with its state under /var/lib. Run from the
# checkout, as root, after `git pull`; safe to run again: it only creates what
# is missing and moves the data once, from where the old units kept it
# (ops/state/watch.json, points/data/) to the new state directories.
#
#   cd ~/launch-pad && sudo bash ops/deploy/install-units.sh
#
# The watch's settings stay in /etc/notus/watch.env (ops/deploy/watch.env.example);
# the points service reads /etc/notus/points.env if it exists (POINTS_TOKEN).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash ops/deploy/install-units.sh"; exit 1; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
[ "$REPO" = /home/notus/launch-pad ] || echo "note: the units name /home/notus/launch-pad; this checkout is $REPO"
OWNER=$(stat -c %U "$REPO")
HOME_DIR=$(getent passwd "$OWNER" | cut -d: -f6)
[ -f /etc/notus/watch.env ] || { echo "/etc/notus/watch.env is missing: the watch's settings (ops/deploy/watch.env.example)"; exit 1; }

echo "== users: one per service, in the group $OWNER so each reads the checkout, nothing more"
for u in notus-watch notus-points; do
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
  usermod -aG "$OWNER" "$u"
done
chmod 750 "$HOME_DIR"   # the owner and the group read it; nobody else
chmod 700 /etc/notus
chmod 600 /etc/notus/*.env 2>/dev/null || true

echo "== stopping the services (if running) before their data moves"
systemctl stop notus-watch notus-points 2>/dev/null || true

echo "== state directories, the data moved once"
install -d -o notus-watch -g notus-watch -m 750 /var/lib/notus-watch
if [ ! -e /var/lib/notus-watch/watch.json ] && [ -f "$REPO/ops/state/watch.json" ]; then
  install -o notus-watch -g notus-watch -m 640 "$REPO/ops/state/watch.json" /var/lib/notus-watch/watch.json
  echo "   the watch's state: $REPO/ops/state/watch.json -> /var/lib/notus-watch/watch.json"
fi
install -d -o notus-points -g notus-points -m 750 /var/lib/notus-points
if [ -z "$(ls -A /var/lib/notus-points)" ] && [ -d "$REPO/points/data" ] && [ -n "$(ls -A "$REPO/points/data")" ]; then
  cp -a "$REPO/points/data/." /var/lib/notus-points/
  chown -R notus-points:notus-points /var/lib/notus-points
  echo "   the points data: $REPO/points/data/ -> /var/lib/notus-points/ ($(find /var/lib/notus-points -type f | wc -l) files)"
fi

echo "== units"
install -m 644 "$REPO/ops/deploy/notus-watch.service" /etc/systemd/system/notus-watch.service
install -m 644 "$REPO/points/deploy/notus-points.service" /etc/systemd/system/notus-points.service
systemctl daemon-reload
systemctl enable --now notus-watch notus-points
sleep 3
systemctl --no-pager --lines=0 status notus-watch notus-points || true
echo
echo "== the services' own view of themselves (a few seconds after the start)"
echo "   watch:  journalctl -u notus-watch -n 5 --no-pager"
echo "   points: curl -s http://127.0.0.1:8789/health"
echo "   once both run, the old copies may go: rm -rf $REPO/ops/state $REPO/points/data"
