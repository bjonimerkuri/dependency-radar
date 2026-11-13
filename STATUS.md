# Status of Dependency Radar

## Done and tested
- Part 1 to 4: read package.json and lockfile, npm registry analysis, where each package is used in the code, changelog check and optional AI explanation.
- Part 5 and 6: web service (plain Node, no framework), demo, GitHub repository analysis, limits, Docker, CI.
- Part 7: pre-install check (CLI `check`, web `/check`).
- Part 8: from a security ticket to concrete changes. Planner with tests (`remediate.ts`), several copies and paths, overrides for npm, Yarn and pnpm, conflicts with existing overrides and direct dependencies, `--force` and downgrade warnings, OSV lookup of missing fixed versions (`advisories.ts`), changelog check for major fixes (`fix-changelog.ts`), terminal and HTML views, CLI `fix`, web `/fix`, `/fix/example`, `/fix/demo`, `/api/fix`.
- Part 9.1: description for a PR or Jira (`pr-description.ts`): Markdown or plain text, English or Albanian, length limits, no invented ticket ids.
- Part 9.2: several tickets at once (`tickets.ts`, `planMultiRemediation`): one diff, a ticket to change table, merged duplicates, lowest common fixed version, partial failure.
- Tests: core 516, cli 56, service 103 (all pass). Typecheck is clean.

## Not done on purpose
- Part 9.3: a GitHub Action and an `npx` package. The CLI already has `fix --fail-if-changes` and exit codes, and the analysis engine is the shared `@dependency-radar/core` package, so the Action is mostly packaging. The plan says to build it only when everything else is online and stable.
- pnpm-lock.yaml and yarn.lock parsing (the path of an indirect package cannot be traced for those projects).
- A suggestion to update the parent package that pulls in a vulnerable copy (only `npm update` and overrides are suggested).
- NestJS, React and Postgres versions of the web service.

## Notes
- The ticket parser reads one block of text well. In a pasted text without blank lines between tickets, a "fixed in" line can be given to the wrong package, which is why several tickets must be separated by a line of dashes.
