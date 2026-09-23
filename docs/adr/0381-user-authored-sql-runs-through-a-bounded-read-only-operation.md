# 0381. User-authored SQL runs through a bounded read-only operation

- **Status:** Proposed
- **Date:** 2026-09-09
- **Amends:** [ADR-0312](0312-a-sqlite-handle-is-all-run-and-batch-and-a-transaction-never-crosses-a-process-boundary.md) and [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) at the three-verb SQLite contract: add restricted `query` while retaining trusted `run`, `all`, and `batch` and the absence of transaction callbacks.
- **Unbuilt:** Complete desktop Local Mail workflow verification; engine and transport checks are separate evidence.

## Context

`AppSqliteDatabase.all(sql)` returns rows from trusted application SQL. SQLite
can return rows while changing data, as `DELETE ... RETURNING` does. The method
therefore cannot safely execute SQL supplied by an editor. A read-only file
also leaves connection operations and access to unintended relations to address.

Local Mail needs reporting over one Gmail account's downloaded facts. A saved
query is ordinary authored text. Saving it establishes neither permission to
execute nor evidence that its SQL is valid.

## Decision

**User-authored SQL runs through `AppSqliteDatabase.query`, with an application-owned
read policy enforced by the SQLite execution owner.**

```ts
const result = await database.query(sql, {
  tables: ['messages', 'labels'],
  signal,
});
```

`database` is an already opened, scoped connection. The application chooses it
and supplies the permitted `main` tables. The editor supplies SQL and can request
cancellation. Local Mail's product operation captures the selected Google subject,
opens its cache, and fixes `tables` internally. The UI does not accept a table
policy, database filename, or another account's connection from saved SQL.

| Boundary | What it fixes |
| --- | --- |
| Opened Personal store | Application and captured account |
| Selected database | One application's named file; in Local Mail, one Gmail cache |
| `tables` | Physical main-schema tables readable by the statement, including nested reads |
| SQLite policy | One read-only statement, admitted functions, bounded work, and bounded output |

The table list grants table-level reads, including all columns. It supplies no
row or column permissions and is not a sandbox for hostile application code.
Applications are trusted and retain `run`, `all`, and `batch` for their own SQL.
If a table contains facts the editor must not read, the application must not
admit that table. Local Mail admits cached `messages` and `labels`; it does not
expose registry, credential, or pending-intent storage.

**SQLite parses the statement and authorizes its actual operations.**

The owner checks parser tails under the same policy and refuses a second
statement. It denies writes, schema changes, attachment, transaction control,
PRAGMAs, extension loading, unsafe functions, and reads outside the admitted
main tables. CTEs and approved JSON table-valued functions can derive results
from permitted inputs. A physical table named `json_each` or `json_tree` does
not acquire the built-in function's exemption. Neither a SELECT prefix nor
`sqlite3_stmt_readonly()` alone establishes these guarantees.

Runtime `parameters` remain separate bound SQLite values. Every execution uses
fresh prepared statements. Browser execution installs connection-scoped policy
on the OPFS worker connection and restores it after finalization. Desktop
execution uses a fresh restricted read connection in the Rust SQLite owner.
A refused or cancelled query leaves subsequent trusted storage work usable.

**Results preserve columns and positional SQLite values within a fixed budget.**

The public result is a Wellcrafted `Result<QueryResult, DeviceError>`:

```ts
type QueryResult = {
  columns: string[];
  rows: QueryValue[][];
  truncated: boolean;
};
type QueryValue =
  | null | string | number
  | { integer: string }
  | { blob: string }; // Hexadecimal bytes.
```

Column metadata survives zero-row results and duplicate column names. Integer
tags preserve signed 64-bit values; finite real numbers remain numbers. Blobs
remain bytes encoded as hex. SQL or binding errors, refusal, interruption, and
execution-budget exhaustion return failures rather than partial successful rows.
Row or result-byte exhaustion can return a truncated result. Result cells render
as text in the application.

`packages/device/src/query.ts` owns the current limits: 64 KiB SQL, 1 MiB per
value, 128 columns, 1,000 rows, 1 MiB for the complete serialized QueryResult,
one million VM operations, and a one-second execution deadline. Native and
browser enforcement must satisfy the same upper bounds; they need not return
identical row counts when conservative byte accounting truncates earlier.
The deadline is an engine execution budget, not a promise about total queue or
transport latency.

Cancellation targets one invocation and bypasses its execution queue. Completion
waits for engine cleanup. It never releases a connection or ownership claim
while that invocation can still use it, and never terminates a shared worker
merely to cancel one query. Browser cancellation between row batches combines
with SQLite progress checks to bound a step that cannot process worker messages.

The desktop WebSocket uses one validated binary codec in both directions:
`Uint8Array` becomes a tagged byte array in JSON and is decoded before statement
or response validation. Restricted-result hex tags remain distinct. Local
serialization or request-size refusal rejects that request; an actual pipe
failure retires the native port and informs its supervisor.

## Consequences

Saved and unsaved SQL share one execution boundary. Saving, syncing, selecting,
or editing a query never runs it. A query can report counts, joins, and JSON
facts without receiving Gmail credentials or modification methods.

The backend must maintain authorizer policy, bounds, cancellation, and value
transport on both engines. Tests must exercise actual browser workers and the
desktop transport as well as the native adapter. Passing an adapter-only test
cannot establish that a WebSocket preserves binary values.

The API deliberately offers reporting over approved facts. Cross-account joins,
actionable message results, row-level grants, persistent results, and automatic
execution require separate product decisions.

## Considered alternatives

- Execute editor SQL with `all`: row production does not imply read-only behavior.
- Check for SELECT or split on semicolons: does not use SQLite's grammar or enforce nested access.
- Rely only on read-only opening: leaves relation and connection-operation policy unspecified.
- Let saved queries supply `tables`: lets authored input grant itself read access.
- Add another query owner or generic query framework: duplicates the existing scoped connection and operation lifetime.
