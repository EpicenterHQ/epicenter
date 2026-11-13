# 0870. An app's secrets are `.local` files, and a `.local` file never leaves its computer

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-11
- **Amends:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) at "a place for secrets (the Keychain)": an action's place for secrets is a `.local` file in its folder. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `secrets`: a run reaches `folder` only. [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at the `secrets` row of the host table, which is deleted. [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at "Is it a secret? yes → the Keychain" and "a secret is never a file", for an app in an Epicenter; a program's own sign-ins (Whispering's account) stay in the Keychain. Also at "a collection whose path contains `.local.` is refused": such a collection is allowed and offers no actions.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) (Keychain access never stopped a program running as the same user), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (read-only runs), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`actions()`), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (the marker, which loses its `id`).
- **Built:** 2026-11-11. A run's context is `{ folder }`; `isLocalPath` in `@epicenter/app` names a `.local` path for the read-only run, `actions()`, the disk's `0600`, and the snapshot's refusal alike. The memory folder has no file modes, so `0600` is the disk's alone. The marker's `id` goes with ADR-0868. 2026-11-13: a `.local` collection's `problems` and refused writes name a field without quoting its value (`misfit` in `packages/app/src/collection.ts`).

## Context

A run reaches two things: `folder` and `secrets` (`packages/app/src/context.ts`).
`secrets.get`, `set`, and `delete` go to the macOS Keychain through
`Bun.secrets`, under the service `epicenter.<id>.<app>`. Here `<id>` is the
random `id` in `epicenter.root.json`. The `id` exists only to name that
service, so two Epicenters on one computer keep apart and a renamed folder
keeps its secrets. Tests replace the Keychain with `EPICENTER_TEST_SECRETS`.

That costs a second store beside the folder, a test hook, and the `id`, and it
protects less than it seems:

- Keychain items written by `Bun.secrets` are readable without a prompt by any
  process running that `bun`. Every agent's script on the home runs `bun`.
  ADR-0849 already says Keychain access does not stop another program running
  as the same user.
- An agent with a shell on the home can call `epicenter mail …` and act with
  the token without ever reading it. The boundary that matters is which
  actions an agent may run, not where the token sits.
- Deleting `epicenter.root.json` orphans every secret, and that file is in no
  repository, so no backup restores it.

The Keychain does stop one thing: copying the raw token out to use elsewhere.
Same-user processes can still read it through `bun`, so it doesn't stop that
cheaply.

Meanwhile `.local` already means "this computer only". The template
`.gitignore` lists `*.local` and `*.local.*`, and a snapshot refuses to
commit either when an app's `.gitignore` lets one through (ADR-0850).

## Decision

**A `.local` file never leaves its computer.** A path matching `*.local` or
`*.local.*` in any case, anywhere in an app's folder, has these properties:

| Path | Property |
| --- | --- |
| snapshot (`packages/cli/src/snapshot.ts`) | never committed, so never pushed to `origin`: the app's `.gitignore` leaves it out, and a snapshot refuses one it lets through (already true) |
| `actions()` of a collection whose `path` matches `*.local` or `*.local.*` | refused when called: `<path> never leaves this computer, so it offers no actions` |
| a read-only run (`readOnlyHint: true`) | may write and delete `.local` paths through `folder`; everything else stays refused |
| a file `folder` creates at a `.local` path | mode `0600`; a directory it creates on one is `0700` |
| a collection whose `path` is not `.local` | never matches or fills a `.local` path, so a value such as `token.local` is not a record |
| a read's `problems`, or a refused write, of a `.local` collection | names the field without quoting its value: `refreshToken is not text` |

The second row keeps generated verbs from handing a token to an MCP client
through one spread. The third row exists because a read-only action may
need to refresh an access token. Read-only means "changes nothing in the
app's history", and a `.local` file is never in it. The last row keeps a
mistyped token out of a message that reaches a caller or a log.

`.local` means "this computer only". It holds a sign-in and a cache alike, such
as Mail's `mail.local.sqlite`; it is not a secret store.

**An app never returns or throws a value it read from a `.local` file.** The
`actions()` refusal covers generated verbs; this rule covers the actions the
app writes, since `serve` hands an answer and a thrown tagged error to its
caller whole.

**A secret never arrives as an action's input.** Input reaches `serve` as MCP
arguments or an HTTP body, so it sits in the calling agent's transcript, and
its first positional value names the call's commit. A secret arrives by the
person editing the `.local` file, or by a flow the action runs that brings it
back to this computer itself: Mail's `connect` takes only a `port`, and
Google's code returns on a loopback listener or the terminal.

### What each layer defends

| Who could get a secret | What stops it |
| --- | --- |
| an agent or page that reaches the app only through `serve` (MCP or HTTP) | the action layer: generated verbs refuse `.local` collections, and the app's own actions follow the rule above. Where the file sits changes nothing here. |
| the app's backup `origin` | the ignore file and the snapshot's refusal |
| a shell agent on the host, by accident (`grep -r`, `cat`, an upload of the folder) | nothing in Epicenter. A deny rule for `*.local*` in that agent's own permissions covers it, and covers caches as well. |
| a shell agent on the host, on purpose | nothing: it can edit `epicenter.ts` to return the value, or read the Keychain through `bun`. Choosing which agents get a shell is the boundary. |
| a stolen disk or a copied backup | FileVault and an encrypted backup, which the host keeps |
| another macOS user | `0600` |

**An app's secret is a one-file collection whose path ends in `.local.md`.**
Its fields are declared in `epicenter.ts` like any other, and its values live
in a Markdown file on the computer that runs the app's actions:

```ts
const google = defineCollection({
  path: 'data/google.local.md',
  description: "this computer's Google sign-in",
  fields: {
    account: field.text({ optional: true }),
    refreshToken: field.text({ optional: true }),
  },
});

// in an action
const { refreshToken } = await google.get();
```

```txt
~/Epicenter/apps/mail/
  epicenter.ts              declares google.local.md's fields
  data/
    messages/<id>.md        data, committed
    google.local.md         the token: 0600, never committed, never offered by a generated verb
```

Reads check it field by field like any file, and `problems` say what does not
fit. `google.set` writes it through `folder.update` (ADR-0850), so two runs
refreshing at once each write over the text they read.

**The Keychain and the `secrets` capability are deleted:**

- `secrets` and `Secrets` from `@epicenter/app` (`packages/app/src/context.ts`,
  `index.ts`), and `createMemorySecrets` from `memory.ts`;
- `packages/cli/src/secrets.ts`, with `keychain`, `keychainService`, and
  `EPICENTER_TEST_SECRETS`;
- the `keychain` field of `epicenter <app> --json`;
- the `id` in the Epicenter's marker (ADR-0868), which existed only to name
  the Keychain service.

## Consequences

- A run's context is `folder`. A test seeds a secret by seeding its file in
  `createMemoryContext`.
- Moving an app's folder moves its secrets. A fresh clone of the backup, or a
  starter, has none: the person signs in again, as before.
- A token is a plain file that any process of the same user can read, as with
  `gh`, `aws`, and `npm`. FileVault protects it on a stolen disk. The
  computer's own backup copies it, Time Machine for example; Git never does.
- People who must not read each other's secrets need separate macOS users or
  separate computers. This was already true with the Keychain (ADR-0868).
- Existing Keychain entries under `epicenter.<id>.<app>` are not read. No app
  writes any today.
- The marker no longer has to be backed up for secrets to stay reachable.

## Considered alternatives

- **Keep the Keychain.** It stops a raw token from being read by a process
  that is not `bun`, and from a shell agent's accidental `grep`. The first is
  not the threat here. The second is better met by the agent's own deny rule,
  since the Keychain cannot hold what sits beside the token: Mail's whole
  mailbox is `mail.local.sqlite`. It costs a second store, a test hook, and
  the root `id`.
- **A declared secret with a pluggable store.** It abstracts over one kind of
  credential, inherits the costs of every store it allows, and changes no
  case in the table above.
- **A `field.secret()` input,** read by the CLI from a prompt that does not
  echo, refused by MCP and HTTP, and left out of the commit's name. It would
  give a pasted API key a path that keeps the entry rule. It waits for the
  second app that needs one; Mail needs none.
- **`secrets.local.json` behind the `secrets` API.** It would fix the `id`
  problem but keep a second storage model with no field types, defaults, or
  `problems`. ADR-0868 rejected it as "one `cat` away from any agent"; the
  Keychain is one `bun -e` away, so that reason does not separate them.
- **Encrypt `.local` files with a key in `~/.config/epicenter/`.** The key
  sits beside the file, readable by the same user, so it protects only
  against a copy of the folder without the key: a backup of `~/Epicenter`
  alone. Git already never copies `.local` files that `.gitignore` leaves out.
- **Refuse `.local` collections, as ADR-0858 did.** That left secrets without
  a typed home and kept the Keychain.
