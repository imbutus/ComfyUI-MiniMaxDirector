#!/bin/bash
# Loads the extension as a real ES module. `node --check` parses as a script and misses a
# backtick inside a template literal, which is exactly how the editor broke.
set -e
T="${TMPDIR:-/tmp}/mmd-loadcheck"; rm -rf "$T"; mkdir -p "$T/pack/web" "$T/scripts"
cp -R "${1:-$(cd "$(dirname "$0")/.." && pwd)}"/web/* "$T/pack/web/"
printf 'export const api = { apiURL: (s) => s, fetchApi: async () => ({ ok: true, json: async () => ({}) }), addEventListener() {} };\n' > "$T/scripts/api.js"
printf 'export const app = { canvas: null, registerExtension() {}, graph: null, extensionManager: {} };\n' > "$T/scripts/app.js"
printf 'export const ComfyWidgets = {};\n' > "$T/scripts/widgets.js"
cd "$T"
node --input-type=module -e "
globalThis.document = { createElement: () => ({ getContext: () => ({ measureText: () => ({width:10}) }), style:{}, classList:{add(){},toggle(){}}, appendChild(){}, addEventListener(){} }), getElementById: () => null, head: { appendChild(){} } };
globalThis.window = {}; globalThis.ResizeObserver = class { observe(){} };
await import('./pack/web/minimax_director.js');
console.log('module graph loads');
"
