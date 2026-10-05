## Summary

<!-- What does this change and why? Keep the PR to one issue. -->

Closes #

## How it was tested

<!-- Commands run, databases used (Postgres / MongoDB), manual checks, screenshots for UI changes. -->

## Checklist

- [ ] The PR title follows Conventional Commits (`type(scope): subject`); it becomes the squash commit
- [ ] `pnpm format:fix && pnpm check` passes locally (format, lint, typecheck, integration tests)
- [ ] Works on both Postgres and MongoDB (no adapter-specific features, ids typed `string | number`)
- [ ] Collection changes: `pnpm generate:types` run, Postgres migration created on a fresh database
- [ ] Docs / `.env.example` / `docs/configuration.md` updated when configuration changed
- [ ] Ported code carries an attribution comment and is listed in `THIRD_PARTY_NOTICES.md`
- [ ] Screenshots attached for UI changes
- [ ] No commit trailers (`Co-authored-by`, `Signed-off-by`, tool or session links)
