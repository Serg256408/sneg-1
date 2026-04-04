## Skills
A skill is a local instruction bundle stored in a `SKILL.md` file. This project has local skills for safer and faster work with the Transcom reporting app.

### Available skills
- transcom-project-workflow: Use when working anywhere in this repo so changes go into the real source files, commands are run from the repo root, and generated artifacts are refreshed correctly. (file: ./.codex/skills/transcom-project-workflow/SKILL.md)
- transcom-report-generation: Use when refreshing data, rebuilding the report, or checking how `analytics.js` produces `report.html` and `deploy/index.html`. (file: ./.codex/skills/transcom-report-generation/SKILL.md)
- transcom-deals-ux: Use when improving the usability, layout, filtering, or readability of the deals view in the generated report UI. (file: ./.codex/skills/transcom-deals-ux/SKILL.md)

### How to use skills
- If a task touches the overall repo workflow, start with `transcom-project-workflow`.
- If a task changes data refresh, report generation, `.env` usage, or rebuild commands, also use `transcom-report-generation`.
- If a task changes the interface for viewing deals, filters, cards, or readability, also use `transcom-deals-ux`.
- For report logic and UI changes, edit the real source in `src/`. `analytics.js` is only a compatibility wrapper and `report.html` / `deploy/index.html` remain generated artifacts.

## Report Rules
- Daily report generation must pre-transcribe same-day call recordings that still have no text before assembling deal cards and manager summaries.
- Before sending a new audio file to Whisper, always check existing transcript storage in both `ai_cache.json` and `transcriptions_cache.json`.
- Transcript reuse must work by both Planfix file id and a stable audio-name signature so previously processed calls are not transcribed twice.
- Manager AI summaries and deal AI comments may be auto-sent to Planfix only after the day report has been fully built for that manager.
