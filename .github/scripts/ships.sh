#!/usr/bin/env bash
# Usage: ships.sh <plugin dir> <git diff range...>   e.g. ships.sh jevfort origin/main...HEAD
# Exit 0 when the diff changes what a plugin ships or is built from: <plugin dir>/package.json, <plugin dir>/src/**
# or <plugin dir>/plugin/**. Only such a change needs a version bump and a release (pr.yml, release.yml); tests,
# scripts and Claude memory (CLAUDE.md, .claude/) do not. Exit 1 otherwise.
set -euo pipefail
p=$1
shift
! git diff --quiet "$@" -- "$p/package.json" "$p/src/" "$p/plugin/"
