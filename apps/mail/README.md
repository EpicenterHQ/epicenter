# Mail

Mail over a synthetic Gmail mailbox, as an app in `~/Epicenter/mail`.
It needs no account, OAuth, network, or credentials. Label changes stay on
this computer until `reconcile` delivers them; reads show them immediately.
[ADR-0873](../../docs/adr/0873-a-mail-label-change-waits-in-intent-local-sqlite-until-reconcile-gmails-only-writer-confirms-it.md)
records the storage split and Gmail's one writer.

## Layout

The app tracks its code and saved searches; SQLite files stay on this computer.

```txt
mail/
  epicenter.ts                actions and the saved-view collection, tracked
  lib/fixture.ts              fictional messages and labels, tracked
  lib/gmail.ts                persistent synthetic Gmail adapter, tracked
  lib/mail.ts                 action-scoped stores and label resolution, tracked
  lib/query.ts                search terms compiled to bound SQL, tracked
  lib/reconcile.ts            delivery followed by a mirror refresh, tracked
  lib/store.ts                mirror and durable intent transactions, tracked
  ui/                         SvelteKit UI source, tracked
  views/<name>.md             saved query, optional title, notes in body, tracked
  .cache/mirror.sqlite        rebuildable mailbox mirror, ignored
  .cache/ui/                  built UI, ignored
  intent.local.sqlite         undelivered label assertions, ignored
  fixture-gmail.local.sqlite  synthetic provider state, ignored
```

SQLite journal files are ignored too. Dependencies and `ui/.svelte-kit/`
are ignored.

## Actions

Prefix CLI words with `epicenter mail`. MCP inputs are objects; `?` marks
optional fields. CLI list inputs accept repeated flags; omitted `add` and
`remove` become empty arrays.

| CLI words | MCP tool | Input | Writes |
| --- | --- | --- | --- |
| `refresh` | `mail_refresh` | `{}` | Mirror; seeds the fixture on first open |
| `search [query]` | `mail_search` | `query?`, `view?`, `limit?` (default 50, minimum 1) | No logical change |
| `show <id>` | `mail_show` | `id` | No logical change |
| `labels` | `mail_labels` | `{}` | No logical change |
| `label <ids> --add <label> --remove <label>` | `mail_label` | `ids`, `add`, `remove`: string arrays | Local intent only |
| `reconcile` | `mail_reconcile` | `{}` | Provider, mirror, and retired intent |
| `status` | `mail_status` | `{}` | No logical change |
| `views list` | `mail_views_list` | `{}` | No |
| `views get <path>` | `mail_views_get` | `path` | No |
| `views add <name> --query <query>` | `mail_views_add` | `name`, `query`, `title?`, `body?` | New view |
| `views set <path>` | `mail_views_set` | `path`, `query?`, `title?` | View fields |
| `views edit <path> --old <text> --new <text>` | `mail_views_edit` | `path`, `old`, `new` | View body |
| `views delete <path>` | `mail_views_delete` | `path` | Deletes view |

`label` needs an id and at least one label to add or remove. It resolves
system ids and custom ids or names without case sensitivity. Unknown labels
and a label in both lists are refused before writing any assertion.
`search --view` accepts a name or `views/<name>.md`; `--query` narrows it.
`views set` merges fields, and `title: null` removes the optional title.
`views edit` replaces an exact passage that occurs once, or fills an empty
body when `old` is empty.

Read actions advertise `readOnlyHint`; SQLite files may still be initialized
when opened. Mail's writes advertise idempotence and no destructive effect.
`refresh` and `reconcile` advertise `openWorldHint: true`; other actions are
local. View actions use the collection annotations: reads are read-only,
`add` is nondestructive, and `set` and `delete` are idempotent.

## Query syntax

Terms combine with AND. A leading `-` negates a term, and double quotes keep
spaces together, as in `subject:"bookshop receipt"` or `-label:Travel`.
Text searches ignore case and match substrings. Supported terms are:

- Bare text: subject, sender name or address, recipient, snippet, and body.
- `from:`, `to:`, `subject:`: text within the named fields.
- `label:`: an exact label id or name, ignoring case.
- `in:inbox`, `in:trash`, `in:spam`, `in:anywhere`.
- `is:read`, `is:unread`, `is:starred`, `is:important`, `is:pending`.
- `after:YYYY-MM-DD`, `before:YYYY-MM-DD`: strict comparisons to midnight
  UTC; `YYYY/MM/DD` also works.

Trash and spam are hidden unless a term mentions `in:trash`, `in:spam`,
`in:anywhere`, `label:trash`, or `label:spam`, even when that term is negated.
Unsupported operators fall back to bare-text search. Results use effective
labels, including pending changes, and sort newest first, then by id descending.

## The synthetic fixture

`lib/fixture.ts` seeds 24 messages in six threads: Moss Bookshop, Juniper
Cycles, Vale Rail, Nora Bell, Orchard Letter, and Eli Rowan. Their addresses
use `example.com`, `example.org`, and `example.net`; the recipient is Mira Lane.
The seed has 22 inbox messages, one trash message, one spam message, 12 unread
messages, and one starred message. An ordinary empty search returns 22 messages.

The custom labels are Receipts (`Label_1`, eight messages), Travel (`Label_2`,
four), and Family (`Label_3`, four). Eleven system labels bring the label
count to 14. The first message id is `0000000000000001`.

The adapter seeds `fixture-gmail.local.sqlite` on first open. Delivered
changes survive a new CLI process, a server restart, and deleting `.cache/`.
To reset the synthetic provider, delete `fixture-gmail.local.sqlite` while
no call has it open, then refresh. Pending intent lives separately and survives
that reset.

## Data ownership and lifetimes

The mirror is disposable. `refresh` reads every provider message and replaces
the mirror in one transaction. `MIRROR_VERSION` identifies its schema;
opening an incompatible nonzero version recreates the file. Delete `.cache/`
and call `refresh` to rebuild the mirror; rebuild the UI separately.

`label` writes one intent row per message and label, with a new sequence on
every assertion. `search`, `show`, and label counts overlay those assertions
through `effective_labels`; `status` reports their count and oldest time.
Intent is never rebuilt and does not travel to another clone.

Only `reconcilePass` calls the provider's `modifyMessage`. Reconcile sends
one call per message, folds the returned labels into the mirror, and retires
only the `(message_id, label_id, seq)` rows it sent. A newer assertion survives.
It then refreshes. A 400 or 404 retires the carried rows and reports them in
`discarded`. Other delivery failures stop sending, keep undelivered intent,
and throw `Delivery stopped: ...`; rerun reconcile to retry. Nothing sends
changes on a timer.

Only `views add`, `set`, `edit`, and `delete` can commit a change. They write
through the collection and folder runner. SQLite writes bypass the folder,
record no paths for the runner, and make no commit. Views are the person's
Markdown; the UI persists nothing itself. A real Gmail adapter is unbuilt.

## Demo walkthrough

With this app at `~/Epicenter/mail`, load the fixture, save a search, and
record a star before delivering it:

```sh
epicenter mail refresh
epicenter mail search 'label:receipts is:unread'
epicenter mail views add --input '{"name":"receipts","query":"label:receipts","title":"Receipts"}'
epicenter mail search --view receipts
epicenter mail label 0000000000000001 --add starred
epicenter mail status
epicenter mail reconcile
```

On a fresh fixture, refresh reports 24 messages. The unread search returns
four, and the saved search returns eight. Status shows one pending assertion;
reconcile delivers it and reports zero pending assertions.

The matching MCP tool calls use these arguments:

```json
[
  { "name": "mail_search", "arguments": { "query": "label:receipts is:unread" } },
  { "name": "mail_search", "arguments": { "view": "receipts" } },
  { "name": "mail_label", "arguments": { "ids": ["0000000000000001"], "add": ["starred"], "remove": [] } },
  { "name": "mail_reconcile", "arguments": {} }
]
```

## The UI

In `ui/`, `bun run build` writes `.cache/ui/` at the app root.
`epicenter serve` serves it at `/mail/`. The page shows saved searches, labels
with total and unread counts, and a search box. A message page has Star,
Archive, Mark read, and custom-label controls. Pending assertions show
"waiting to send"; "Send changes" runs reconcile. Delivered labels show
"Sent" for the current page session. Refresh reloads the provider snapshot.

For development, run `bun run dev` in `ui/` with `epicenter serve` running.
`EPICENTER_URL` selects its address, defaulting to `http://127.0.0.1:4747`.
The Vite proxy forwards MCP requests to that server.

## Tests

In `apps/mail`, run `bun test` and `bun run typecheck`.
In `apps/mail/ui`, run `bun run typecheck`, `bun test`, and `bun run build`.
`epicenter.cli.test.ts` runs the real CLI from `packages/cli` in a temporary
HOME. It checks commits, delivery across processes, and rebuilding the mirror
without losing delivered changes.
