# Apollo

## Quality gates

After any code change, run all of the following and make sure they pass before considering the work done:

- `bun run lint` - formats (oxfmt) and lints (oxlint) the project.
- `bun run typecheck` - type-checks the project with `tsc --noEmit`.
- `bun run build` - bundles with `bun build` to verify the app compiles.
- `bun run test` - runs the test suite with `bun test`.

## Dashboard

The dashboard must stay responsive - everything has to work on both mobile and desktop.

## Tests

- Tests live under `tests/`, mirroring the `src/` tree: `src/foo/bar.ts` is tested by `tests/foo/bar.test.ts`.
- A test file only tests things defined in its corresponding source file. It does not import or assert behaviour from other modules.
- Not every file needs tests. Cover pure, self-contained logic; skip files that are only side effects or thin I/O wrappers (e.g. `index.ts`, `whatsapp.ts`).
