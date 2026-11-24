#!/usr/bin/env bash
# Usage: is-plugin.sh <dir>
# Exits 0 when <dir> is a plugin: its package.json has a claudePlugin key (the marker every
# plugin keeps; tsdown.config.ts forwards it as the preset's manifest). Detection never relies on committed build output.
jq -e 'has("claudePlugin")' "$1/package.json" >/dev/null 2>&1
