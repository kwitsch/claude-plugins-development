#!/usr/bin/env bash
# Usage: ships-notice.sh <plugin dir> <state>   state = a `ships.sh` output other than `ship`
# One GitHub annotation per state, shared by pr.yml and release.yml so their wording cannot drift apart.
set -euo pipefail
case $2 in
none) echo "::notice::$1: no build input and no version changed, nothing ships" ;;
version) echo "::warning::$1: version changed without a build input change, nothing ships" ;;
content) echo "::notice::$1: build inputs changed without a version bump, nothing ships; bump the version together with the input change" ;;
*)
  echo "::error::ships-notice.sh: unknown state '$2' for $1"
  exit 1
  ;;
esac
