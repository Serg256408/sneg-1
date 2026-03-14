---
name: transcom-report-generation
description: Use when refreshing data, rebuilding reports, checking .env-dependent behavior, or understanding how analytics.js generates report.html and deploy/index.html in this repo.
---

# Transcom Report Generation

## Overview

Use this skill for report rebuilds, data refreshes, and debugging the generation pipeline from Planfix data to static HTML.

## Core Files

- Generator: `analytics.js`
- Cached structured data: `latest_data.json`
- AI cache: `ai_cache.json`
- Funnel snapshot: `funnel_snapshot.json`
- Final HTML: `report.html`
- Static deploy copy: `deploy/index.html`

## Main Modes

- Full refresh from data source:
  - `.tools/node-v24.14.0-win-x64/node.exe analytics.js "Боровая"`
- Rebuild HTML only from cache:
  - `.tools/node-v24.14.0-win-x64/node.exe analytics.js --html`
- Syntax check:
  - `.tools/node-v24.14.0-win-x64/node.exe --check analytics.js`

## Use Cases

- Report page does not reflect source changes
- Need to rebuild HTML after UI edits
- Need to verify generated data artifacts
- Need to debug why `report.html` differs from `deploy/index.html`
- Need to work with `.env`-driven integrations safely

## Safe Workflow

1. Edit `analytics.js`
2. Run syntax check
3. Rebuild HTML with `--html` if the task is UI-only
4. Run full refresh only when data actually needs to change
5. Copy `report.html` to `deploy/index.html`

## Important Notes

- `report.html` is generated, not the long-term source file.
- `deploy/index.html` should mirror `report.html` after a successful rebuild.
- If browser output breaks, extract the inline script from `report.html` and syntax-check it with Node.
