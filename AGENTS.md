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
- For UI changes, edit `analytics.js` first. Do not treat `report.html` or `deploy/index.html` as the source of truth.
