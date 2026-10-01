# 0315. The folder is keyed by data id, and the segment under it is the application's

- **Status:** Accepted
- **Amended at the layout by [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md).** The folder is `~/Epicenter/<data-id>/` with no segment under it, because the `local`/`account` pair this record moved went with the device store (ADR-0336) and there is one store per data id to render. What survives is this record's reasoning about why two renderers must never share one swept directory, which ADR-0337's single working copy makes moot rather than answers. What this record decided about the data id being the key stands.
- **Built:** the folder claim, in `apps/epicenter/src/checkout.ts`, which takes a lock per folder so two writers cannot interleave. Nothing else here shipped.
- **Date:** 2026-08-31
- **Amends:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at the layout block and at the closed set of places. The one-way rule, the complete pass, and the manifest are unchanged and are what force everything below.
- **Amends:** [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at its line saying the human folder is untouched, which was written before this.
- **Relates:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) (the folder a person and an agent both read), [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md) and `packages/app/src/data/store/claims.ts` (the refusal this borrows), [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) and [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (a data id and an app id are not required to be equal)

## Context

The mirror renders to `~/Epicenter/<place>/<data-id>/<table>/<rowId>.md`, where
`place` is one of two literals, `local` or `account`.

Three things about that are worth separating, because only one of them is
wrong.

**The place segment cannot be removed.** A pass carries a manifest and the
host deletes every rendered file the manifest does not name
(`apps/epicenter/src/checkout.ts`). Two renderers sharing one directory therefore
delete each other's files on every pass, silently, in the folder ADR-0271
describes as the copy that outlives a reclamation. Honeycrisp opens a device
store and an account replica for one data id today, so this is the shipping
shape rather than a hypothetical.

**Keying by app id is also wrong.** ADR-0303 and ADR-0313 established that a
data id and an app id are not required to be equal: one app may open several
data domains, and a data domain may be opened by several apps. Under app-id
keying, two apps opening one domain mirror it twice into one directory, which
is the same duelling sweep.

**What is wrong is the order, and the closed set.** Place-first splits one
domain into two distant subtrees, so "everything Honeycrisp" is two trees in
this root while ADR-0314 just decided it is one directory in the other. And
the closed set is a platform opinion about a value the application already
passes at every call site: `attachMirror({ …, place: 'local' })`.

## Decision

**The data id is the key, and the segment under it is the application's.**

```txt
 ~/Epicenter/
   so.epicenter.honeycrisp/
     local/     notes/<rowId>.md  folders/<rowId>.md  tables.sqlite  kv.json
     account/   notes/<rowId>.md  …                   tables.sqlite  kv.json
   so.epicenter.vocab/
     local/     …
```

**`place: MirrorPlace` becomes `folder: string`.** One path segment, validated
the way the data id already is, so `.` and `..` are refused by construction.
`MIRROR_PLACES`, `MirrorPlace`, and `isMirrorPlace` are deleted. The route
becomes `PUT /api/mirror/:dataId/:folder`.

**There is no default.** Every call site already passes the value, so a default
would be surface nothing uses, and the one default anybody would reach for,
flattening into the data id's own directory, is exactly the duelling sweep
above. Requiring it makes the dangerous case unwritable.

**A mirror claims its folder.** Two mirrors on one directory are refused rather
than allowed to sweep each other, the same refusal `claims.ts` makes for two
opens of one document address: two writers, one address, work that disappears
converged with nothing to retry.

**`local` and `account` survive as convention, not as a rule.** They are what
those two stores are, so applications will keep passing them; an application
with two account replicas, or one that means something else, says something
else.

## Consequences

- `ls ~/Epicenter/so.epicenter.honeycrisp/` shows both piles side by side,
  which is the disk form of the decision ADR-0270 made for the interface.
  Backing up or sharing one domain is one directory.
- The shipped `.gitignore` still needs one line. A pattern without a leading
  slash matches at any depth, so `account/` covers every domain's view.
- `~/Epicenter` loses a shape the platform can promise. An agent pointed at it
  can no longer assume the second segment, and `tables.sqlite` is written per
  leaf folder rather than once at the root, so discovery is a walk. That is the
  price of the application owning the segment, and it is already the price of
  third-party applications existing.
- Nothing at a call site changes. Honeycrisp keeps passing `'local'` and
  `'account'`; the constraint moves from a union to a segment check.

## The obligation this does not discharge

Signing in as a different principal destroys the previous principal's mirrored
files. The account folder is a view: B's first complete pass names only B's
rows, so the sweep removes A's. Meanwhile A's replica is retained in the data
root across sign-out, so the durable copy ADR-0271 promised is the one that is
destroyed while the fragile one survives.

No layout on the table fixes this, and naming the principal in the path was
already priced and refused (a nickname, a marker file, a rename verb, a
collision rule, and a sweep that reads the marker before deleting). **The
answer is a consent moment on account switch**, parallel to ADR-0270's first
dialog: this folder holds another account's mirror, and continuing replaces it.
That is interface work, recorded here because this is the record that made the
hazard legible.

## Considered alternatives

- **`~/Epicenter/<data-id>/` with no segment.** Refused by the sweep, above.
  Not a preference.
- **`~/Epicenter/<app-id>/<place>/`.** Refused because a data id and an app id
  are many-to-many.
- **`local` and `remote` as the two words.** Refused: what is mirrored is the
  replica of an account-scoped authority, and `account` is the word a person
  already has for it.
- **A default derived from `sync === undefined`.** Considered and dropped. It
  is safe, but every call site passes the value anyway, so it defends a case
  that cannot arise and adds a rule a reader has to know.
- **Human titles as directory names.** Refused: it needs the nickname registry,
  the rename verb, and the collision rule that naming an account was refused
  for.
