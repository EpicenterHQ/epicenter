# Capture

Capture is a signed-in web app over the one Personal `so.epicenter.capture` store. Its root shows top-level entries by capture time; opening an entry shows its editable body and immediate children. The URL holds an entry ID, so the same view opens at any depth. The inert definition and entry operations live in [`packages/capture`](../../packages/capture/).

Run `bun dev:capture` from the repository root. `bun run --cwd apps/capture smoke:browser` starts a disposable self-hosted issuer and two isolated Chromium contexts. It verifies direct typing, reload, three nested levels, timeline order, and synchronization. The fixture deletes its temporary server state when it exits.

This slice has no move, deletion, Markdown handoff, or Whispering promotion action. Their product decisions remain Proposed in ADRs 0432 through 0435 and 0439 through 0441.
