#!/bin/sh
# Runs the dependency-free core tests without needing the internet (the full workspace needs crates.io).
# Usage: sh rust/tools/verify-core.sh
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
cp -r "$here/vexlo-core" "$tmp/vexlo-core"
mkdir -p "$tmp/tools"
printf '[workspace]\nmembers = ["vexlo-core"]\nresolver = "2"\n' > "$tmp/Cargo.toml"
cd "$tmp" && cargo test --offline -q -p vexlo-core
