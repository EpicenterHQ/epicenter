# Execute one active account per host

Implement [the one-active-account spec](20260908T214916-one-active-account.md)
in `/Users/braden/conductor/workspaces/epicenter/yamoussoukro`. Deliver a verified
implementation and a concise report of what collapsed, how stock-client Cloud
and self-host sign-in work, and what was actually tested. Use `spec-execution`
and independent `design-review` checkpoints. Do the work rather than stopping
at another plan.

The user explicitly chose Cloud by default, one custom-server URL/token option,
and exactly one active account. Changing the server or account closes affected
Apps and applies the new choice through full navigation or host restart. A
stock desktop installation must support self-hosting. Requiring a rebuilt host
was considered and rejected; do not restore the earlier build-fixed plan.

Read [ADR-0374](../docs/adr/0374-the-host-selects-one-account-and-replacement-restarts-its-applications.md)
and the spec's target, baseline, occurrence map and safety matrix first. The
host owns selection and credentials; its app windows receive the captured boot
Account and cannot choose another server. Browser apps retain the equivalent
one-document boundary. Ordinary token renewal does not require restart. Core
same-person uninterrupted reauthentication preserves Account identity, while
actual browser redirects and native sign-in may still leave the runtime.

Planning HEAD was `2dee4a2cbea98c02f5d22bff7a6a25a9a7929def`. Extensive unrelated
uncommitted work already exists in auth, desktop, bootstraps, inference and
recording. Capture current tracked and untracked state before editing. Preserve
it; a HEAD-only worktree omits relevant current code. This conversation created
only planning documents and their index entry, not runtime implementation.

The central revision matters: the target no longer deletes all selection code.
Consolidate one real sign-in/selection owner and remove inactive status,
redundant wrappers, capability guessing and App retargeting. Candidate
verification, scoped persistence, cancellation, close barriers and restart still
have real consumers. Classify every occurrence instead of chasing zero grep hits.

Pay particular attention to:

- Matching destination/auth method/credential before cached identity or requests,
  including revocation; never retarget saved credentials using runtime URL env.
- Real initial instance token entry and reentry: existing requestToken callbacks
  throw while connectInstance supplies the actual enrollment path.
- Preserving strict Account identity during uninterrupted same-person reauth and
  tracing forced-fresh sign-in options into the real handoff.
- Cancellation after retirement: restoring a saved choice cannot revive the old
  Account or closed Apps. Recovery needs a fresh document/process.
- Failed native persistence/relaunch: old windows cannot receive a new Account.
- Removing only auth's constant ConnectionStatus/no-op subscriptions. Keep real
  sync status and reactive refusal/recovery/retirement.
- Distinguishing absent selection from malformed selection. A corrupt browser
  selector currently restores a surviving Cloud credential; the planning review
  reproduced that fallback. Require deliberate recovery with no replacement
  cached Account, and preserve existing data.
- Keeping the existing two-stage return to Cloud where useful. A no-library
  sign-in surface can precede normal completion/relaunch; exactly one restart
  is not a requirement and does not justify a second staged auth owner.
- Scoping one active Account to each process/document. Do not introduce cross-tab
  replacement coordination or persist closed App/departure state across refresh.
- Using the self-host Worker for sync acceptance. Authentication does not make
  the Bun reference support sync or make unconfigured inference ready. Preserve
  instance services while suppressing Cloud-only account-management links.
- UI, native routes/settings, barrels/exports, constants, callback documents,
  tests, smoke fixtures and docs in the occurrence sweep. Keep durable authority
  bytes and data addresses; changing servers must not move local data.

Use radical-options and greenfield-clean-breaks for ownership decisions, and a
focused collapse-pass if repeated indirection remains. Independently review the
cumulative changes after substantive waves and revise remaining work from valid
findings. Do not add simultaneous accounts, a server wallet, per-app routing,
a new auth protocol, or automatic data migration.

Planning verification passed 165 tests across 18 files:

```sh
bun test packages/auth/src apps/epicenter/src/desktop-auth-authority.test.ts packages/app-shell/src/boot-screens/departure.test.ts packages/app-shell/src/boot-screens/desktop-close.test.ts
```

No builds, typechecks, browser smokes or packaged native checks were completed
in planning. Repeat the baseline, execute the spec's broader matrix, and report
attribution and limits precisely. Resolve task regressions without erasing other
work. The prompt authorizes implementation and verification, not commits,
installation, deployment or publication. Do not self-assign ADR acceptance;
follow docs/adr/README.md. Retire planning artifacts only once their work and
required evidence are complete and durable decisions are recorded.
