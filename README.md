# Dependency Radar

Tells you which dependency updates will break your code.

## Status

Parts 1 and 2 are done in `@dependency-radar/core`, and `@dependency-radar/cli` prints the result in the terminal.

- Part 1: reads and validates a package.json (and an optional package-lock.json), classifies every version specifier, and records the exact line and column of each dependency.
- Part 2: looks up each package in the npm registry (retries, backoff, timeouts, host allow-list, cache) and gives every dependency a preliminary verdict from semver: safe, review or breaking candidate, with a confidence level and the reasons.

## Requirements

Node.js 22.18 or newer. The tests run TypeScript directly with Node's built-in type stripping.

## Try it on a project

```
npm run radar -- path/to/package.json
```

It reads the package-lock.json next to it when there is one. Options: `--all`, `--json`, `--fail-on-major`, `--lockfile <path>`, `--no-color`.

## Run

```
npm install
npm test
npm run typecheck
```

## Usage

```ts
import { readProject } from '@dependency-radar/core';

const result = readProject({ packageJson, lockfile });
if (result.ok) {
  console.log(result.value.entries, result.warnings);
} else {
  console.error(result.error.message, result.error.position);
}
```

```ts
import { analyzeProject, createMemoryCache, createRegistryClient, readProject, withCache } from '@dependency-radar/core';

const registry = withCache(createRegistryClient(), createMemoryCache());
const parsed = readProject({ packageJson, lockfile });
if (parsed.ok) {
  const { results, summary } = await analyzeProject(parsed.value.entries, { registry });
}
```

A "breaking candidate" is only a major version change. It becomes a real "breaking" verdict in part 3 and 4, once the code that uses the package is checked.

## Known limits

- Only package-lock.json is read. pnpm-lock.yaml and yarn.lock are reported as unsupported.
- Monorepos: only the given package.json is analyzed.
- Registry lookups use the abbreviated npm metadata, so release dates are not available.
- At most 300 packages are analyzed per project.
- Git, URL, local and workspace dependencies are listed but marked as not analyzable.
