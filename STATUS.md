# Status of Dependency Radar

## Done and tested
- Part 1 to 4: read package.json and lockfile, npm registry analysis, where each package is used in the code, changelog check and optional AI explanation.
- Part 5 and 6: web service (plain Node, no framework), demo, GitHub repository analysis, limits, Docker, CI.
- Part 7: pre-install check (CLI `check`, web `/check`).
- Part 8, building blocks only: ticket parser (`ticket.ts`), JSON text editor (`json-edit.ts`), diff (`diff.ts`), lockfile graph (`lock-graph.ts`), and the planner `planRemediation` (`remediate.ts`).

## Part 8: what is still missing
- Tests for `remediate.ts` (the planner has only been tried on one example by hand).
- A terminal view and a GitHub-style HTML view of the diff and of each finding.
- CLI command `fix` and web routes `/fix` and `/api/fix`.
- README section.

## Not started
- Part 9: PR or Jira description, several tickets at once.
- Optional extras for part 8: look up missing fixed versions (OSV), suggest a newer parent package, check the changelog for major bumps.
- NestJS, React and Postgres versions of the web service.
