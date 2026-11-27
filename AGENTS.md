# Repository Guidelines

## Project Structure & Module Organization

This package implements transparent conversation compaction as a native Magpie Provider plugin. `autocompact.provider.js` exposes provider slots. `lib/` contains configuration, transport, compaction, history caching, and persistent session management; `lib/core.js` holds protocol-independent planning.

`test/` contains unit and regression tests. `scripts/integration.mjs` exercises the real Magpie/Bun host with local mock upstreams. `scripts/probe-compaction.mjs` supports manual investigation. `examples/options.jsonc` is the canonical configuration example, and `README.md` documents installation and behavior, primarily in Chinese.

## Build, Test, and Development Commands

Use Node.js 22.13 or newer for development and tests. Production runs inside Magpie's Bun host. There are no npm runtime dependencies or build steps.

- `npm test`: run all tests using Node's built-in test runner.
- `node --test test/provider.test.js`: run a focused test file.
- `npm run test:integration`: run host integration tests; requires an installed `magpie` executable. Tests use temporary HOME/XDG directories and loopback mock services.
- `npm pack --dry-run`: inspect package contents before release.
- `magpie plugin add "$PWD"`: register this checkout for manual testing in PowerShell.

## Coding Style & Naming Conventions

Use JavaScript ES modules, explicit `.js` extensions in local imports, two-space indentation, double-quoted strings, and semicolons. Follow existing compact formatting without reformatting unrelated code. Use camelCase for functions and variables, descriptive kebab-case module filenames, and `*.test.js` test filenames. No formatter or linter is configured.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; no coverage threshold is configured. Add behavior-focused regression tests to the relevant suite. For transport or session changes, cover protocol differences, JSON/SSE responses, tool-call boundaries, failure recovery, and provider/session isolation as applicable. Run integration tests when changing host registration or transport behavior.

## Commit & Pull Request Guidelines

The short Git history uses plain subjects such as `auto fetch models`; no formal prefix convention is established. Use concise, action-oriented subjects. Pull requests should describe the behavior change, link relevant issues, and report validation commands and results. Update the README and canonical configuration example when changing options or user-visible behavior.

## Security & Configuration

Keep real API keys and provider credentials out of commits and test fixtures. `.env`, `.state/`, coverage output, and package archives are ignored. Preserve credential redaction and provider isolation when changing logging, errors, or persistent state.
