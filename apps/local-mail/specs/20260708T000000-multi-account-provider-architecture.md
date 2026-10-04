# Local Mail: multi-account + Gmail/Graph architecture

- **Status:** Draft
- **Date:** 2026-07-08
- **Scope:** Storage shape, account identity, provider engines, and the smallest
  shared contract for a combined inbox across Gmail and Microsoft Graph.

## Product sentence

> Local Mail shows one combined list of inbox-like items across your connected
> mailboxes, and routes every detail view and every action back to the mailbox
> that owns it.

That sentence is the whole design. It promises a **merged reading list**, not a
merged mail *model*. It does not promise cross-provider feature parity, a
universal label/folder vocabulary, or a mailbox you can act on without knowing
whose it is.

## The decision in one line

Keep one **provider-native, disposable SQLite mirror per account**. Build the
combined inbox as a **read-time union of a tiny `inbox_index` view** that each
engine defines over its own schema. **Refuse a shared `NormalizedMessage`
object model.** Identity moves to a **JSON account registry** keyed by a minted
`account_id`; email is demoted to display metadata.

## Why not normalize (the asymmetric win)

Gmail and Graph do not share an object model. They share *display scalars*.

| Concern | Gmail | Microsoft Graph |
|---|---|---|
| Sync cursor | one mailbox-wide `historyId` | one `deltaLink` **per folder** + `mailFolders/delta` |
| Organization | labels (flat, many-per-message) | folders (containment, one-per-message) + categories (tags) |
| "Inbox" | `INBOX` label present | message's `parentFolderId` is the Inbox folder |
| "Archive" | remove `INBOX` label | **move** to Archive folder |
| "Read" | remove `UNREAD` label | set `isRead` **property** |
| "Star" | `STARRED` label | `flag.flagStatus` **property** |
| "Trash" | `TRASH` label / `messages.trash` | **move** to Deleted Items folder |
| Identity | stable `id` | `id` **changes on move** unless `Prefer: IdType="ImmutableId"` is sent consistently |

Gmail's model is "everything is a tag." Graph's model is "folders contain,
categories tag, read/flag are properties." A shared `messages/folders/tags`
schema forces one provider's model onto the other. Whichever way it leans, the
loser pays a permanent, lossy, two-way translation tax, and every new engine
re-pays it.

**The refusal:** do not build a shared object model. The combined list needs
seven display scalars, all of which *are* genuinely universal (every mail
system has sender/subject/date/read). Labels, folders, categories, and flags
never enter the shared layer; they live only in per-provider detail and
actions, which already route back to the owning engine.

```txt
Product sentence:  Combined inbox list; detail + actions route to the owner.
Candidate refusal: A shared NormalizedMessage with shared labels/folders/tags.
Deletion prize:    The entire normalization layer, both translation directions,
                   per-provider tag/folder mapping tables, the drift between the
                   normalized copy and the provider truth, and every "how does
                   Graph's move map to a Gmail label" branch that never converges.
User loss:         None at the list level. Cross-provider "apply the same label
                   to a Gmail and an Outlook message in one gesture" is refused,
                   because that gesture has no honest meaning.
Why asymmetric:    Zero list-level product loss deletes a permanent subsystem.
```

## Storage shape: keep the per-account mirror, aggregate virtually

**Keep one mirror DB per account. Unchanged and load-bearing.** Provider-native,
disposable, provider-owns-truth, rebuilt on `SCHEMA_VERSION` bump. This is the
best existing decision in the app; multi-provider does not touch it.

**Two things change:**

1. The mirror directory is keyed by `account_id`, not by email
   (`<data-dir>/<account_id>/mail.db`). This deletes `mailDbPath`'s
   path-segment injection guard: `account_id` is a minted opaque token, not a
   user-influenced string.
2. Each engine's mirror defines one standard **read view**, `inbox_index`,
   mapping its native schema to the shared display scalars:

   ```sql
   -- Gmail mirror (over today's messages table):
   CREATE VIEW inbox_index AS
   SELECT id            AS message_ref,
          internal_date AS received_at,
          sender, subject, snippet,
          NOT EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value='UNREAD') AS is_read
   FROM messages
   WHERE     EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value='INBOX')
     AND NOT EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value='TRASH');

   -- Graph mirror (over its own messages table) defines the SAME view name/columns:
   CREATE VIEW inbox_index AS
   SELECT immutable_id     AS message_ref,
          received_date_ms AS received_at,
          sender, subject, snippet,
          is_read
   FROM messages
   WHERE parent_folder_id = (SELECT id FROM folders WHERE well_known='inbox');
   ```

The combined inbox is then a **stateless read verb**, not stored state:

```sql
-- listCombinedInbox: attach each registry mirror, stamp account_id + provider.
SELECT 'acct_01' AS account_id, 'gmail' AS provider, * FROM acct_01.inbox_index
UNION ALL
SELECT 'acct_02' AS account_id, 'graph' AS provider, * FROM acct_02.inbox_index
ORDER BY received_at DESC LIMIT ? OFFSET ?;
```

### Why virtual (view union) beats a materialized aggregate index

The mission's option 2 (a generated `inbox_index` *table* the engines write) and
option 1 (a view composed at query time) both refuse the object model. The only
question is where the combined-list complexity lives.

- A materialized index introduces a **second writer** and **two owners** for
  `is_read`/`in_inbox`: once as the provider-native form in the mirror, once as
  a boolean in the index. That is exactly the ownership violation the greenfield
  pass exists to prevent. It also needs drift detection and rebuild-on-drift.
- At personal scale (single-digit accounts, tens of thousands of rows each),
  read-time fan-out costs nothing. Materialization buys throughput we will never
  spend, at the price of a duplication we would have to police forever.

**Recommendation: virtual (option 1).** The mirror is the sole owner of every
value; the view is a pure function of it; adding a provider adds a mirror that
defines the view and changes nothing in the aggregate. The materialized index
stays a **documented escape hatch**, built only if a real user's account count
ever makes fan-out hurt (a live-producer trigger, not a speculative one).

Reject option 3 (full shared schema) per the asymmetric win above. Reject option
4 (engines return list/detail/action descriptors, no SQL storage) as
over-abstraction: it discards the app's core asset, "your mail is real
queryable SQLite," and replaces an honest `switch(provider)` at the action
boundary with a descriptor protocol. **Harvest exactly one idea from option 4:**
the provider engine owns its *action set* (see "Provider UI/actions").

### ATTACH ceiling

SQLite's default `SQLITE_MAX_ATTACHED` is 10. Two mitigations, in order of
preference:

- **Refuse >N accounts for v1** (another honest asymmetric refusal; keeps the
  aggregate a single SQL statement). Verify Bun's compiled limit before setting N.
- If a real user exceeds it, drop ATTACH and do a **JS k-way merge**: query each
  mirror's `inbox_index` independently (each returns a sorted page) and
  merge-sort the streams. Removes the ceiling; slightly more paging code. Defer
  until needed.

## Account registry: JSON file, minted id, single owner

Today identity is *derived*: an account is "a key in `credentials.json`," the
mirror path is derived from the email, and selection is `LOCAL_MAIL_ACCOUNT=<email>`.
Email is simultaneously the token key, the directory name, and the selector.
That collapses the moment `provider` exists (you cannot derive Gmail-vs-Graph
from an address), and natural keys are the wrong identity anyway (Graph's
immutable-id lesson applied one level up).

**Recommendation: a JSON registry at `<data-dir>/accounts.json` is the single
owner of account identity.** It matches the existing `credentials.json` /
`provider.json` file-tier convention (ADR-0062 lineage), is human-inspectable,
and is tiny. SQLite is overkill (its own schema/version/home for a handful of
rows); derived-from-disk is what we are leaving.

```jsonc
// accounts.json — the one owner of account identity
[
  {
    "account_id": "acct_01HZ...",   // minted ULID, provider-independent, stable
    "provider": "gmail",            // "gmail" | "graph"
    "email": "me@gmail.com",        // DISPLAY metadata only, never an identifier
    "display_name": "Personal",
    "mirror_dir": "acct_01HZ...",   // relative to data-dir
    "token_ref": "acct_01HZ..."     // key into credentials.json
  }
]
```

**Value owners after this change:**

| Value | Owner |
|---|---|
| account identity, provider kind, mirror path, display metadata | `accounts.json` |
| OAuth tokens | `credentials.json`, keyed by `token_ref` (= `account_id`) |
| per-mailbox message/label/folder truth | that account's mirror DB |
| combined inbox row | the read-time union (owns nothing; pure view) |

Clean break: **email stops being an identifier anywhere** (token key, directory,
selector all become `account_id`). Email is display-only. The `connect` flow
mints `account_id`, records provider, and is the only writer of `accounts.json`.

## Runtime: one-account-per-process becomes account-addressed

`openLocalMailRuntime` freezes exactly one account per process, and the MCP
server leans on "one frozen identity per session" so a mid-session connect can't
flip which mailbox tools talk to.

That frozen-account rule was a **workaround for implicit selection**. Once every
account-scoped operation names its `account_id` explicitly, there is nothing to
flip, and the rule dissolves.

- **Combined/read surfaces** (`GET /api/messages`, status) iterate the registry.
- **Single-account surfaces** (sync, detail, every write) take `account_id` and
  resolve that account's engine + mirror + token. Writing is *inherently*
  single-account: you trash a specific Gmail message in a specific mailbox.
- **MCP** tools gain an `account` parameter (reads may run combined). Drop the
  frozen-single-account design; explicit addressing replaces it.

## Gmail engine (exists; becomes one engine behind dispatch)

Unchanged in substance, re-seated behind `account_id` dispatch:

- Cursor: one mailbox-wide `historyId`. FULL = `messages.list` + per-id
  `messages.get`; INCREMENTAL = `history.list` folded to a per-message final
  action. `gmail.modify` scope; `messages.trash`/`untrash` as dedicated verbs;
  `messages.delete` deliberately never wired. Poll (installed-app appropriate).
- Labels are both tags and system states (`INBOX`/`UNREAD`/`STARRED`/`TRASH`).
- Adds: the standard `inbox_index` view. Directory keyed by `account_id`.

## Graph engine (new)

- **Cursor is per-folder, not per-mailbox.** Enumerate folders via
  `mailFolders/delta`; hold one `deltaLink` per folder in `_meta`; run
  `messages/delta` per folder. This is a real structural difference from
  Gmail's single cursor and the mirror's `_meta` must model it (a folder→deltaLink map).
- **Immutable IDs are a correctness invariant.** Send `Prefer: IdType="ImmutableId"`
  on every request and store the immutable id as `message_ref`; otherwise ids
  churn on move and the mirror corrupts.
- Organization: **folders contain** (one parent per message), **categories tag**.
  `in_inbox` = `parentFolderId == Inbox`. Read = `isRead` property. Star =
  `flag.flagStatus`. Archive/Trash = **moves** to well-known folders.
- **Refuse webhooks for v1.** Change notifications need a reachable public HTTPS
  endpoint and renewal; an installed app has none. Poll `messages/delta` like
  Gmail. Deletion prize: the whole subscription/notification-URL/renewal
  subsystem never gets built.
- Defines the same `inbox_index` view over its native schema.

## Smallest shared interface

Two contracts, both minimal. Nothing else is shared.

1. **`inbox_index` SQL view** (the read contract). Exactly:
   `message_ref, received_at, sender, subject, snippet, is_read` — inbox-scoped,
   trash-excluded. The aggregate stamps `account_id` + `provider`. Add a column
   only when a live combined-list producer needs it (e.g. `has_attachments`).
   `thread_ref` is deferred: threading is provider-shaped and lives in detail.
2. **A `MailEngine` behavioral interface** (the write/detail contract), one
   implementation per provider, dispatched by `provider` from the registry:
   `sync(account)`, `getDetail(account, ref)`, and an action surface. The data
   flowing through detail and actions stays **provider-shaped**; this interface
   is behavior, not a normalized data type.

There is no shared message *type* beyond the flat `InboxRow` display projection.
`InboxRow` is scalars for rendering a list row, not a domain object with tags or
folders.

## Provider-specific UI/actions

- **Combined list** renders purely from `inbox_index`: sender, subject, snippet,
  date, unread weight, plus a small **account/provider chip** (avatar or icon).
  No provider branching here; it is all shared scalars.
- **Detail + actions dispatch by provider.** The *intents* are universal
  (archive, read/unread, star, trash, apply-label-or-category, move-to-folder);
  the *implementation per intent* is provider-specific and honest:

  ```txt
  intent: archive
    gmail -> remove INBOX label      (today's planToggle('inbox'))
    graph -> move to Archive folder
  intent: read
    gmail -> remove UNREAD label
    graph -> set isRead = true
  ```

  This is a `switch(provider)` at the action boundary, not a normalized action
  model. Two unlike operations get two call shapes (honest asymmetry).
- **The available action set may differ by provider** (Gmail: arbitrary labels;
  Graph: folders + categories). The detail pane asks the engine "which controls
  apply to this message." This is option 4's one good idea, scoped to action
  controls only, not to storage or the list.

Today's `ui/src/lib/actions.ts` (`planToggle`/`planLabel` over `INBOX`/`UNREAD`/
`STARRED`) becomes the **Gmail** action adapter, unchanged. A Graph adapter is
written beside it. They never merge.

## Asymmetric refusals (the deletion prize)

1. **Refuse the shared object model.** Deletes the entire normalization layer
   and both translation directions. (Largest prize.)
2. **Refuse Graph webhooks; poll.** Deletes the subscription/notification/renewal
   subsystem.
3. **Refuse a materialized aggregate index (for now).** Deletes the second
   writer, the second owner of `is_read`, and drift/rebuild logic.
4. **Refuse combined browsing beyond the inbox.** The combined view is
   inbox-only; all-mail, folders, and labels are per-account (route into that
   account's engine). Deletes cross-provider folder/label reconciliation.
5. **Refuse email-as-identifier.** Deletes `mailDbPath`'s injection guard and the
   email/directory/token coupling.
6. **Refuse >N accounts (v1 cap).** Keeps the aggregate one SQL statement; no
   ATTACH-overflow or k-way-merge code.

## Open decisions before implementation

0. **Is a combined inbox actually promised, or is per-account switching enough?**
   Highest-leverage question. If only switching is promised, build the registry
   + account-addressed runtime and **stop** — the entire aggregate layer
   (view union, ATTACH, InboxRow) is deleted. My recommendation assumes combined
   inbox is real; confirm it.
1. **Does Local Mail become a *mail* client (Gmail + Graph)?** ADR-0083 names it
   "the only *Gmail* client." Adding Graph is a scope expansion that should
   amend ADR-0083, not silently contradict it.
2. **Registry migration.** Existing single-Gmail users have `credentials.json`
   keyed by email and a `<email>/mail.db` directory. One-time: mint an
   `account_id`, write `accounts.json`, rename the mirror dir, re-key the token.
   Break vs migrate? (Recommend a one-shot migration; the on-disk mirror is
   disposable, so a full re-pull under the new dir is also acceptable.)
3. **MCP `query` under multi-provider.** Keep per-account native SQL (agent names
   the account, gets that provider's real, disposable schema) and expose the
   combined `inbox_index` as the one cross-account view? (Recommend yes.)
4. **Account cap N**, pending Bun's compiled `SQLITE_MAX_ATTACHED`.
5. **Graph OAuth client** (Azure app registration, delegated `Mail.ReadWrite`
   scope, native/loopback redirect) — the Graph analog of ADR-0083's Desktop
   Gmail client. New external credential; out of band.
6. **Does `read` reach far enough for Graph?** Gmail's `gmail.modify` covers
   label/trash/read/star. Graph's equivalent is `Mail.ReadWrite`. Confirm the
   minimal scope covers move + isRead + flag + categories.
```
