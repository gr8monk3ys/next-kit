## Agent skills

### Issue tracker

GitHub Issues on `gr8monk3ys/next-kit`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label string equal to role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commands

- `bun run check`: lint, typecheck, dependency-cruiser boundaries, tests and build. Run it before every PR.
- Install the pre-commit hook once with `bunx simple-git-hooks`.
- `bun run build` rewrites the committed `dist/`; commit it with any `src/` change (CI fails on a stale `dist/`).
- Module boundaries: `rate-limit`, `auth` and `stripe` must not import each other (`.dependency-cruiser.cjs`). See `docs/adr/0002-committed-dist-and-subpath-exports.md`.
