#!/usr/bin/env bash
# Guard: the AWS engine's init.sh.tpl is FROZEN. user_data_replace_on_change
# is set on the instance, so ANY byte change — even a comment — replaces the
# live engine, destroys the ZFS pool, and kills every branch. The shared
# multi-platform init core (modules/common/engine-init) deliberately excludes
# AWS until the scheduled "engine v2" migration window.
#
# If you*really* mean to change it: plan the destroy/re-sync window first,
# then refresh the golden hash:
#   shasum -a 256 modules/aws/engine/templates/init.sh.tpl \
#     | awk '{print $1}' > modules/aws/engine/templates/init.sh.tpl.sha256
set -euo pipefail
cd "$(dirname "$0")/.."

tpl=modules/aws/engine/templates/init.sh.tpl
golden=$(cat "$tpl.sha256")
actual=$(shasum -a 256 "$tpl" | awk '{print $1}')

if [ "$golden" != "$actual" ]; then
  echo "FROZEN TEMPLATE MODIFIED: $tpl" >&2
  echo "  golden: $golden" >&2
  echo "  actual: $actual" >&2
  echo "Applying this replaces the live engine instance and destroys the ZFS pool." >&2
  exit 1
fi
echo "frozen-userdata check OK"
