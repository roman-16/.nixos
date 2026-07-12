# Apollo

## Quality gates

After any code change, run all of the following and make sure they pass before considering the work done:

- `bun run lint` - formats (oxfmt) and lints (oxlint) the project.
- `bun run build` - bundles with `bun build` to verify the app compiles.
- `bun run test` - runs the test suite with `bun test`.
