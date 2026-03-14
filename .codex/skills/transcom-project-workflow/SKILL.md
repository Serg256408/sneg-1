---
name: transcom-project-workflow
description: Use when working in the Transcom analytics repo so changes go into the correct source files, commands run from the repo root, and generated report artifacts are refreshed safely.
---

# Transcom Project Workflow

## Overview

Use this skill for any task in this repo before making changes. It keeps work pointed at the real source files and avoids editing generated output by mistake.

## Source Of Truth

- Main project root: `c:\Users\speza\.cursor\sneg-1`
- Main application logic and HTML generator: `analytics.js`
- Local server entry: `server.js`
- Runtime config: `.env`
- Generated output: `report.html`
- Deployable static copy: `deploy/index.html`

## Working Rules

- Prefer editing `analytics.js` for behavior or UI changes.
- Treat `report.html` and `deploy/index.html` as generated artifacts.
- If UI changes are needed, regenerate HTML after editing the generator.
- Keep work inside this repo, not in temporary sibling folders.
- If system `node` is missing, use the bundled runtime in `.tools/node-v24.14.0-win-x64/`.

## Default Command Flow

1. Work from the repo root.
2. Make source edits.
3. Run syntax check:
   - `.tools/node-v24.14.0-win-x64/node.exe --check analytics.js`
4. Rebuild generated HTML:
   - `.tools/node-v24.14.0-win-x64/node.exe analytics.js --html`
5. Sync static output if needed:
   - copy `report.html` to `deploy/index.html`
6. Run or verify the local server:
   - `.tools/node-v24.14.0-win-x64/node.exe server.js`

## When A Task Is UI-Only

- Change `analytics.js`
- Rebuild with `--html`
- Verify `report.html`
- Copy to `deploy/index.html`

## When A Task Changes App Execution

- Check `package.json`, `server.js`, `.env`, and `analytics.js` together
- Preserve compatibility with the local bundled Node runtime
