#!/usr/bin/env bash
# Install only the checked release; a failed download/checksum is fatal.
set -euo pipefail
source "$(dirname "$0")/versions.env"
destination="${1:?usage: bash scripts/ci/install-apalache.sh EMPTY_DIRECTORY}"
if [[ -e "$destination" ]]; then
  echo "installation destination already exists: $destination" >&2
  exit 1
fi
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 \
  "https://github.com/apalache-mc/apalache/releases/download/v${APALACHE_VERSION}/apalache-${APALACHE_VERSION}.tgz" \
  --output "$archive"
printf '%s  %s\n' "$APALACHE_SHA256" "$archive" | sha256sum --check --strict
mkdir -p "$destination"
tar -xzf "$archive" --strip-components=1 -C "$destination"
actual="$("$destination/bin/apalache-mc" version)"
[[ "$actual" == "$APALACHE_VERSION" ]] || {
  echo "expected Apalache $APALACHE_VERSION, got $actual" >&2
  exit 1
}
printf 'Installed Apalache %s at %s\n' "$actual" "$destination"
