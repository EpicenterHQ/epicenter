# Capture

Capture is a signed-in web app over the one Personal `so.epicenter.capture` store. Its root shows top-level entries by capture time; opening an entry shows its editable body and immediate children. The URL holds an entry ID, so the same view opens at any depth. The inert definition and entry operations live in [`packages/capture`](../../packages/capture/).

Run `bun dev:capture` from the repository root. `bun run --cwd apps/capture smoke:browser` starts a disposable self-hosted issuer and two isolated Chromium contexts. It verifies direct typing, reload, three nested levels, timeline order, moves, confirmed deletion, and synchronization, including opposing offline moves and a child unseen by the deleting replica. The fixture deletes its temporary server state when it exits.

Move chooses another visible entry or the timeline. Deletion previews the resolved subtree and count, refreshes when local contents change, and waits for local persistence before reporting success. Markdown handoff and Whispering promotion remain later work. The product decisions remain Proposed in ADRs 0432 through 0435 and 0439 through 0441.
