/**
 * The working copy in `~/Epicenter`, and the wire it travels on (ADR-0337).
 *
 * **A push applies the folder, whole, after one approval** (ADR-0338). It
 * validates nothing, deletes a row when its file is gone, reads a removed
 * frontmatter line as `null`, and asks nothing per item: to change any of it,
 * a person cancels, edits the file, and pushes again. A setting in `kv.json`
 * comes back the same way a frontmatter value does.
 *
 * ```txt
 * ~/Epicenter/<data-id>/
 *   .epicenter/manifest.json     what pull handed over, and from where
 *   <table>/<row-id>.md          one row, frontmatter and body
 *   kv.json                      the kv root's stored values
 * ```
 *
 * `pull` fills the folder, `push` sends it back, and nothing happens in
 * between. The continuous mirror this replaces asked the folder to be four
 * things at once, and the fourth, a surface external tools could edit, is
 * where every hard question came from: a filesystem cannot say whether a
 * missing file is a person deleting a note, a `git checkout`, a half-finished
 * Dropbox sync, or a Time Machine restore.
 *
 * **The manifest is the base**, which is what makes those the same question
 * with one answer. `pull` wrote down what it handed over and when, so at push
 * a changed value is an edit and a missing file is a deletion, and there is no
 * watcher, no echo suppression, and no per-file base store to keep. A deletion
 * lands as a deletion: the row goes, and it does not pass through the
 * application's trash on the way (ADR-0338). `PlanItem` is the whole
 * vocabulary of what a plan can say and what may be answered to it.
 *
 * ## Who owns which half
 *
 * The application renders, diffs, and decides. The host writes the files it is
 * handed and reads back the files it holds, and interprets neither: nothing on
 * that side parses frontmatter or reaches a row. ADR-0271 refused a host that
 * reads the folder at all, in service of a one-way rule that is withdrawn, and
 * the narrower refusal is the one that survives.
 *
 * The wire itself is `wire.js`, and it is a separate module because this one
 * reaches `@y/y` to rewrite a live node. A host importing the NDJSON format
 * from here would load a CRDT to concatenate strings, which is exactly the
 * boundary `format.ts` exists to state. Everything pure is re-exported below,
 * so nothing outside the package has two imports to keep straight.
 */
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	type ParsedTable,
} from '../definition/index.js';
import { type ParsedRowFile, parseRowFile } from './frontmatter.js';
import { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
import { type RenderableData, RenderError, renderRow } from './render.js';
import {
	AGENTS_PATH,
	CHECKOUT_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
} from './wire.js';

// Re-exported so one import names the whole verb surface: a component
// diffing and pushing does not have to know which half of it is pure.
export {
	AGENTS_PATH,
	CHECKOUT_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
} from './wire.js';

/**
 * Which store a folder is a working copy of, and which history of it.
 *
 * Exported because `createWorkingCopy` takes it: a caller could satisfy this
 * shape and had no way to name it.
 *
 * The four facts the manifest records and every later comparison is against.
 * They used to arrive as their own argument, assembled by the caller out of a
 * store and a generation kept beside it, and that is how a folder came to be
 * addressable at a generation the store is not. An opened store states its own
 * address now (ADR-0340), so this is a slice of the data handed in rather than
 * a second description of it, and there is nothing left for a caller to get
 * half right.
 */
export type CheckoutAddress = {
	readonly dataId: string;
	readonly generation: number;
	readonly baseURL: string;
	readonly principalId: string;
	/**
	 * What this store holds, compiled, which the opener stamped on it.
	 *
	 * It used to arrive beside the data as a declaration, and each of the three
	 * verbs compiled it again on every call. It is the same fact as `dataId` one
	 * layer down, and taking it from the store is also what makes a malformed
	 * declaration unreachable here: this one compiled, or there would be no
	 * store to hand over (ADR-0340).
	 */
	readonly definition: ParsedDataDefinition;
};

/**
 * What `pull` handed over, and from where (ADR-0337).
 *
 * The base every later comparison is against, and the reason there is no
 * watcher: it is written once, by the side that knows what it rendered, at the
 * moment it rendered it.
 *
 * `values` is stored verbatim rather than hashed, because push resolves per
 * field and needs the base VALUE to tell "the person changed this" from "the
 * store changed this". A body is hashed instead, because it never comes back:
 * a body renders out and does not read back (ADR-0329), so the only question
 * is whether it still matches what was handed over, and a body that does not
 * is text the push carries home whole (ADR-0338).
 */
export type CheckoutManifest = {
	readonly baseURL: string;
	readonly principalId: string;
	readonly dataId: string;
	readonly generation: number;
	/** ISO 8601. A folder is current as of this instant and says so. */
	readonly pulledAt: string;
	/**
	 * One entry per row file, keyed by `<table>/<row-id>` without the `.md`.
	 *
	 * The key is the row's address rather than its path, so nothing that reads
	 * this has to know the file extension the layout chose.
	 */
	readonly rows: Record<
		string,
		{ readonly values: JsonObject; readonly bodyHash: string }
	>;
	/**
	 * What `kv.json` held when it was handed over, key by key.
	 *
	 * Verbatim, for the same reason a row's values are: a push resolves per key
	 * and needs the base VALUE to tell "the person changed this" from "the store
	 * changed this". The kv root is a declared field map compiled by the same
	 * code as a table, and it is last-write-wins per key in the document
	 * (`packages/app/src/data/store/document.ts`), so it resolves the same way.
	 *
	 * It is the base rather than a copy of the file: a folder whose `kv.json`
	 * somebody deleted still has one, and the file coming back is not an edit
	 * to every setting in it.
	 *
	 * So this record holds two rules rather than three: values for everything
	 * that comes back, and a hash for the one region that only renders out.
	 */
	readonly kv: JsonObject;
};

export const CheckoutError = defineErrors({
	/**
	 * Nothing answered. There is no host here.
	 *
	 * A browser build is this case permanently, and it is not a degraded
	 * desktop: the folder is a filesystem and a page does not have one. Distinct
	 * from `HostRefused` because the repair is different and one of them has
	 * none: a retry cannot conjure a filesystem, and a build condition is what
	 * decides whether this verb is offered at all.
	 */
	HostUnreachable: ({ cause }: { cause?: unknown }) => ({
		message: 'There is no Epicenter folder here',
		cause,
	}),
	/**
	 * The host answered and said no.
	 *
	 * A full disk, a read-only volume, or a drive somebody unplugged. The store
	 * is unaffected by every one of them, and a retry is worth offering.
	 */
	HostRefused: ({ status }: { status: number }) => ({
		message: `The Epicenter folder refused the request with ${status}`,
		status,
	}),
	/**
	 * One or more rows could not be rendered, so the checkout would be missing
	 * them.
	 *
	 * Fail-closed, and deliberately unlike the mirror it replaces.
	 * `renderArtifact` does not fail closed because a continuous mirror that
	 * stops on one bad row leaves a folder that lies about the rest and
	 * re-renders on the next commit anyway. A pull is a deliberate act with a
	 * manifest behind it: a row silently absent from the folder reads as a
	 * deletion at the next push, which is data deleted everywhere (ADR-0325).
	 */
	Unrenderable: ({ failures }: { failures: readonly RenderError[] }) => ({
		message: `${failures.length} row(s) could not be written to the folder`,
		failures,
	}),
	/**
	 * A push against a folder nothing here ever wrote.
	 *
	 * Never pulled, manifest deleted, manifest mangled, or manifest written by
	 * another account: with no base, every file might be work nobody has sent
	 * and there is no comparison to print, so there is nothing to approve. The
	 * repair is a pull, which is why this is the push's refusal alone.
	 *
	 * There is no matching refusal for the list moving underneath somebody.
	 * That is not an error any more: the working copy reads the folder again
	 * and asks with the list that is true now (ADR-0341).
	 */
	FolderUnwritten: () => ({
		message: 'nothing here wrote this folder, so there is nothing to send back',
	}),
	/**
	 * The host handed back a folder without saying which folder it is.
	 *
	 * Every write carries the reading it was prepared against, so a reading with
	 * no `ETag` is one nothing can be written from. It is a host too old for
	 * this application or something answering in its place, and neither is a
	 * folder problem a person can repair by looking at their files.
	 */
	HostUnstated: () => ({
		message: 'the Epicenter folder did not say which version it handed back',
	}),
	/**
	 * The other verb is between its preview and its write.
	 *
	 * `confirm` awaits a person, so that stretch is seconds long rather than
	 * instant, and both verbs write the same folder. It is per store rather
	 * than per working copy, so two components each building their own still
	 * meet the same guard.
	 *
	 * Refusing is better than queueing: a second dialog that opens when the
	 * first one closes is a question about a folder nobody has looked at
	 * since.
	 */
	Busy: () => ({
		message: 'the folder is already being read or written here',
	}),
	/**
	 * The host refused the write because the folder is not the one it was
	 * prepared against.
	 *
	 * The same fact `sameReading` checks, from the other side of the wire. This
	 * module compares two readings around the approval, and the host compares
	 * what it holds against the reading the write names, in the same slot it
	 * writes in. Only the host's comparison closes the window between the last
	 * reading and the write, which is why both exist.
	 */
	FolderMoved: () => ({
		message: 'the folder changed before the write landed',
	}),
	/**
	 * A change the plan named could not be applied, and some of the push may
	 * have landed.
	 *
	 * Its own arm rather than an `Unrenderable`, which is what it used to
	 * borrow: nothing here failed to RENDER, and a person told their folder
	 * could not be read would go looking for a folder problem instead of for
	 * work that half landed. Everything reaching here was checked against a
	 * plan read a moment ago, so it means an invariant broke rather than that a
	 * person did something.
	 */
	PushUnapplied: ({ reason }: { reason: string }) => ({
		message: `a planned change could not be applied: ${reason}`,
		reason,
	}),
	/**
	 * The values reached the store and the folder could not be rewritten.
	 *
	 * Its own outcome because the repair is its own: the push WORKED, and what
	 * failed is the write that makes the folder stop showing the old
	 * values. Reporting the write failure alone would send a person looking for
	 * work that already landed, and the next pull would offer to discard edits
	 * that are no longer edits.
	 */
	FolderStale: ({
		rows,
		values,
		bodies,
		deleted,
		admitted,
		cause,
	}: PushOutcome & {
		/**
		 * The `CheckoutError` the write answered with.
		 *
		 * Typed structurally rather than as `CheckoutError`, because naming it
		 * inside the set that defines it is a circular type. What a surface
		 * reads off it is the name, to pick a sentence, and the message, to show
		 * underneath.
		 */
		cause: { readonly name: string; readonly message: string };
	}) => ({
		message: `${values} value(s) and ${deleted} deletion(s) reached the store, and the folder could not be rewritten`,
		rows,
		values,
		bodies,
		/**
		 * The rows this push deleted, which are the one part of it nobody can
		 * undo. Carried for the same reason `admitted` is: a person reading a
		 * stale folder is owed the number that does not come back.
		 */
		deleted,
		/**
		 * The files that became rows, which the folder does not yet show.
		 *
		 * Carried because it is the one part of a stale folder that is not
		 * self-correcting. The rows exist and their files are still at the names
		 * a person gave them, so the next plan offers them as new files again
		 * and a second push mints a duplicate. What clears it
		 * is a pull, which writes each row at its id and sweeps the old name.
		 */
		admitted,
		cause,
	}),
});
export type CheckoutError = InferErrors<typeof CheckoutError>;

/**
 * The hash a body is compared by.
 *
 * SHA-256 through `crypto.subtle`, which both a WebView and Bun have. It is
 * not a security claim: what it answers is "are these the bytes that were
 * handed over", and a collision here would have to be authored on purpose by
 * somebody who already has write access to the person's own folder.
 */
export async function contentHash(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * The working copy as the host holds it: every file, and the base to compare
 * them against.
 *
 * `base` is `undefined` when there is no USABLE one, and that is one fact
 * rather than three. A folder that was never pulled, one whose
 * `.epicenter/manifest.json` a person deleted or a Dropbox conflict copy
 * mangled, and one another account pulled all say the same thing: nothing here
 * wrote down what these files were handed over as. Reading any of them as
 * "clean" is how the one refusal in this module gets bypassed by editing a
 * hidden file.
 */
type FolderContents = {
	readonly base: CheckoutManifest | undefined;
	readonly files: ReadonlyMap<string, string>;
	/**
	 * Which folder this reading is of, as the host stated it.
	 *
	 * It travels back on the write, and the host refuses a write whose folder
	 * moved since. That is why no file here is hashed on its own any more: one
	 * fact about the whole folder answers "is this still what was read", and the
	 * side holding the filesystem is the side that can answer it without a race.
	 */
	readonly etag: string;
};

/**
 * What the folder holds now, read through one route.
 *
 * The manifest is parsed here rather than by the host, because the host
 * interprets nothing: what it returns is files, and which of them is the base
 * is this side's question.
 *
 * `store` is what the base has to describe to BE the base, and that is all four
 * facts including the generation. A manifest naming another account, another
 * database, another server, or another number is not this store's record of
 * what it handed over, so it is not compared against: ADR-0325 binds a database
 * to one authority, and this is the same rule one layer out, where the evidence
 * is a file instead of a transaction. A generation is a whole database
 * (ADR-0281), so a folder pulled from the one before this describes rows that
 * are not these rows, and reading it as a base would call every one of them a
 * deletion.
 */
async function readWorkingCopy(
	store: CheckoutAddress,
	httpFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result<FolderContents, CheckoutError>> {
	const { data: response, error } = await tryAsync({
		try: () =>
			httpFetch(checkoutUrl(store.dataId), {
				// Same-origin and refusing a redirect, for the same reason the blob
				// adapter does: this carries a person's notes to a loopback origin
				// and must not follow one anywhere else.
				credentials: 'same-origin',
				redirect: 'error',
			}),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (error !== null) return Err(error);
	if (!response.ok) {
		return CheckoutError.HostRefused({ status: response.status });
	}
	const { data: body, error: readError } = await tryAsync({
		try: () => response.text(),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (readError !== null) return Err(readError);

	const files = new Map<string, string>();
	for (const file of parseCheckout(body)) files.set(file.path, file.contents);

	const manifest = parseManifest(files.get(MANIFEST_PATH));
	const describesThisStore =
		manifest !== undefined &&
		manifest.dataId === store.dataId &&
		manifest.baseURL === store.baseURL &&
		manifest.principalId === store.principalId &&
		manifest.generation === store.generation;
	const etag = response.headers.get('etag');
	// A host that will not say which folder this is cannot be written to: the
	// write would carry a tag the host refuses, the refusal would read as the
	// folder having moved, and the verb would ask again forever. Failing here
	// says what is actually wrong, once.
	if (etag === null) return CheckoutError.HostUnstated();
	return Ok({
		base: describesThisStore ? manifest : undefined,
		files,
		etag,
	});
}

/**
 * The manifest a folder carries, or `undefined` when what is there is not one.
 *
 * Strict about every field it will later be trusted for. A manifest is the
 * base a person's edits are measured against, so half of one is worse than
 * none: none means "show them everything", and half means "show them the part
 * this happened to parse".
 */
function parseManifest(text: string | undefined): CheckoutManifest | undefined {
	if (text === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Partial<CheckoutManifest>;
	if (
		typeof record.baseURL !== 'string' ||
		typeof record.principalId !== 'string' ||
		typeof record.dataId !== 'string' ||
		typeof record.generation !== 'number' ||
		typeof record.pulledAt !== 'string' ||
		!isJsonObject(record.kv) ||
		typeof record.rows !== 'object' ||
		record.rows === null
	) {
		return undefined;
	}
	return record as CheckoutManifest;
}

/**
 * What this folder is, for whoever opens it (ADR-0337, ADR-0330).
 *
 * Generated from the compiled definition rather than written by hand, so the
 * tables and fields it names are the ones that exist. An agent uses the
 * surfaces a person uses (ADR-0330), and the surface here is a directory of
 * text files; what it needs told is what happens to each kind of edit, because
 * the folder cannot show it and a wasted edit is silent.
 *
 * **Consequences rather than prohibitions** (ADR-0338). This file used to be
 * a list of things not to do, because doing any of them stopped the whole push
 * until a person opened Finder. Now every edit lands: a new file becomes a
 * row, an edited body replaces the note's text, a deleted file deletes the
 * row, and a file the push cannot read is left exactly as it is. The honest
 * thing to say is what each one costs. If this file and the plan ever disagree,
 * this file is wrong, because the plan is what runs.
 *
 * Nothing here is escaped. A table name and a field name are bare identifiers
 * and a data id is dot-separated lowercase labels
 * (`packages/app/src/data/definition/addresses.ts`), so none of them can hold a
 * `|` or a backtick.
 *
 * It depends on the definition and on nothing else: not the time, not the
 * manifest, not the rows. Two writes of one definition are byte-identical, and
 * the host skips a write whose bytes already match, so this file does not churn
 * a person's folder on every pass.
 */
function agentsFile(definition: ParsedDataDefinition): string {
	const lines = [
		`# ${definition.id}`,
		'',
		'These files are a working copy of a database, written by Epicenter.',
		'**A pull replaces every one of them, including this file. A push',
		'replaces only the files it changed.** Anything of your own goes at a',
		'path that is neither `<table>/<row-id>.md` nor one of the three names',
		'below: nothing here ever touches those.',
		'',
		'## The layout',
		'',
		'```txt',
		'.epicenter/manifest.json   what the last write handed over. Do not edit.',
		'AGENTS.md                  this file. Generated; do not edit.',
		'kv.json                    settings, one JSON object.',
		`<table>/<row-id>${ROW_FILE_EXTENSION}        one row: frontmatter, then its text`,
		'```',
		'',
		'## The two verbs, and which one moves this folder',
		'',
		'**A pull writes every file here from the database.** It rewrites every',
		'row file, `kv.json`, this file, and the manifest, and it REMOVES every',
		'row-shaped file the database has no row for, including one you created',
		'and nobody pushed. Before it runs, the person is shown every unpushed',
		'edit it would write over, and chooses. So an edit you have not had',
		'pushed survives only until somebody makes that choice: push before you',
		'stop, or say plainly what is still unpushed.',
		'',
		'**A pull is also the only thing that makes this folder current.**',
		'`pulledAt` in `.epicenter/manifest.json` moves only at a pull. A push',
		'rewrites the manifest without moving it, so if `pulledAt` changed,',
		're-read every file: all of them may have changed, including the one you',
		'were editing.',
		'',
		'A write you make while the person is reading either list makes that verb',
		'read the folder again and show them what is true now, so it is not lost',
		'quietly.',
		'',
		'## What happens to what you edit',
		'',
		'A person pushes your edits back by hand, from the application. You never',
		'do it yourself: the overview they read before approving it is what makes',
		'your work reviewable, and they approve the whole list at once.',
		'',
		'**A push applies all of its changes or none, and rewrites only the files',
		'it changed.** The files it writes are exactly the ones in the overview,',
		'plus `.epicenter/manifest.json` and this file. Everything else in this',
		'folder is left byte for byte as you wrote it, including a file the push',
		'could not read, which is listed at every push until somebody fixes it.',
		'',
		'**This folder does not update itself.** What you are reading is the',
		'database as of `pulledAt` in `.epicenter/manifest.json`. A push does not',
		'refresh it: a note changed in the application since that moment is not',
		'here until the next pull, and a value you read here may be older than',
		'the one the application holds.',
		'',
		'- **A value in the frontmatter comes back.** Change it in place. Some are',
		'  written by the application from the text below and will move back at',
		'  the next edit; the table below does not say which, so prefer editing',
		'  the text to editing a value derived from it.',
		'- **Keep the `---` block**, even when it is empty. Without it the file',
		'  cannot be read at all, so the push takes nothing from it, leaves it',
		'  exactly as you wrote it, and says so. Fix the block and push again.',
		'- **The text under the `---` block replaces the note.** Your version',
		'  wins, and the text that was there is gone, including anything typed in',
		'  the application since this folder was written. It replaces the whole',
		'  text, so write the whole note rather than a fragment, in the form the',
		'  file already uses.',
		'- **A file you create becomes a row, and is RENAMED.** A row id is minted',
		'  rather than chosen, so the push makes the row, gives it an id, and',
		'  writes the file out under that id. Re-read the folder afterwards: the',
		'  name you gave it is gone. Give it every field its table declares, with',
		'  a value that fits: the row is made either way, and one missing half',
		'  its fields is a row the application cannot read until somebody fixes',
		'  it. Copy the frontmatter of a file beside it. A field that points at',
		'  another row can only name one that already exists, because the id of a',
		'  row you are creating in the same push does not exist yet.',
		'- **A file you delete deletes the row, for good.** It does not go to',
		'  whatever the application calls its trash, and nothing puts it back.',
		'  Moving or renaming a file is a delete and a create: the row is deleted',
		'  and a new one is made under a new id, and every field pointing at the',
		'  old id now points at nothing. To trash a note the way the application',
		'  does, edit the frontmatter value it uses for that instead.',
		'- **A frontmatter line you remove reads as `null`**, because that is what',
		'  this format writes for a value that is not there. On a field the table',
		'  below marks `or null` that is the designed no-value; on any other it',
		'  is a value the application cannot read until somebody fixes it. There',
		'  is no way to say "leave this alone" other than leaving the line alone.',
		'- **A name the table does not declare goes in and is read by nothing.**',
		'  So does a value that does not fit its field, and the row then does not',
		'  read at all. Nothing here refuses either: the application shows the row',
		'  as unreadable and the repair is this file. `id` and the text below the',
		'  block are not frontmatter lines, and writing one does nothing at all.',
		'- **A note this release cannot write out leaves its file alone.** The',
		'  file is fine; the row is what cannot be read, so there is nothing in',
		'  the file to fix.',
		'- **A file the push cannot read is left alone**, and nothing else in the',
		'  push is affected. Where only the text under the `---` block cannot be',
		'  read, the frontmatter values in that same file still go in and the',
		'  file is still left as you wrote it.',
		'- **A file you edited whose note was deleted comes back as a note.**',
		'  Under a NEW id, because a row id is minted and never chosen, so the',
		'  file is renamed like any file you create. A file you did NOT edit',
		'  says nothing and the next pull removes it.',
		'- **A value in `kv.json` comes back**, the way a frontmatter value does.',
		'  It is one JSON object of settings. A key you remove reads as `null`,',
		'  and a key you add goes in and is read by nothing. Keep it a JSON',
		'  object: if it will not parse, the push takes nothing from it, leaves',
		'  it exactly as you wrote it, and says so.',
		'- **A file the push rewrote comes back in canonical form**, with its',
		'  keys sorted and its strings quoted. A file it did not rewrite keeps',
		'  your bytes exactly, formatting and all.',
		'',
		'## The tables',
		'',
	];
	for (const [name, table] of [...definition.tables].sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		lines.push(`### ${name}/`, '', '| field | type |', '| --- | --- |');
		for (const field of [...table.fields.values()].sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			lines.push(
				`| \`${field.name}\` | ${field.kind}${field.nullable ? ' or null' : ''}${
					field.reference === null ? '' : ` -> \`${field.reference}\``
				} |`,
			);
		}
		lines.push(
			'',
			table.body === undefined
				? 'These files contain fields only. Do not add body text below the frontmatter; it cannot be imported.'
				: 'The text below the frontmatter is this row, written out and read back.',
			'',
		);
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Render this store into `~/Epicenter/<data-id>/` and write the manifest
 * (ADR-0337).
 *
 * The whole store, every time, because a pull is what makes the folder true as
 * of one instant and a partial one would leave a manifest describing a folder
 * that does not exist.
 *
 * It **writes over everything**, which is why it takes an approval. A pull is
 * the destructive direction: it replaces every rendered file, so the list a
 * person read before saying yes is the list it is allowed to write over
 * (ADR-0341). Confirming it is the discard; there is no second gesture.
 *
 * It **fails closed**, unlike the mirror. A row that could not be rendered
 * would be a file absent from the folder, and absence is a deletion at the
 * next push.
 */
async function applyPull({
	data,
	held,
	fetch: httpFetch,
	now,
}: {
	data: RenderableData & CheckoutAddress;
	/**
	 * The reading a person approved, re-read and found unmoved.
	 *
	 * Its `etag` travels on the write, so the folder this replaces is the one
	 * they were shown even if something lands while these files render.
	 */
	held: FolderContents;
	fetch: typeof globalThis.fetch;
	now: () => Date;
}): Promise<Result<{ files: number }, CheckoutError>> {
	// The store's own set of paths: every row it holds is rendered, and a file
	// the folder holds that the store does not is simply not sent, which is how
	// a pull sweeps it.
	const state = data.stored();
	const sources: FileSource[] = [];
	for (const [table, held] of state.tables) {
		for (const rowId of held.keys()) sources.push({ render: { table, rowId } });
	}
	const kvContents = JSON.stringify(state.kv, null, 2);
	return writeFolder({
		data,
		definition: data.definition,
		sources,
		kv: { contents: kvContents, values: state.kv },
		pulledAt: now().toISOString(),
		ifMatch: held.etag,
		fetch: httpFetch,
	});
}

/**
 * The entry a kept file carries forward, with anything this push applied to it.
 *
 * **A base that advanced past a file that did not move is the failure this
 * exists to prevent, and a base that did NOT advance past a value that DID
 * move is the same failure from the other side.** A file whose body a codec
 * refused still had its frontmatter values written, so the store holds them
 * and the file on disk says them; an entry still naming the pulled value would
 * read that file as an edit at the next push and write it back over whatever
 * another device had done since.
 *
 * The body's hash is the base's, because the body is the part that did not go.
 */
function carried(
	base: CheckoutManifest,
	address: { table: string; rowId: string },
	applied: ReadonlyMap<string, JsonObject>,
): ManifestRow | undefined {
	const entry = base.rows[`${address.table}/${address.rowId}`];
	const wrote = applied.get(rowPath(address.table, address.rowId));
	if (entry === undefined || wrote === undefined) return entry;
	return { values: { ...entry.values, ...wrote }, bodyHash: entry.bodyHash };
}

/** One row's entry in the manifest: what was handed over for that file. */
type ManifestRow = { readonly values: JsonObject; readonly bodyHash: string };

/**
 * Where one file in a checkout comes from.
 *
 * The one thing the two verbs disagree about (ADR-0341). A pull's set is the
 * store's, so every file is rendered; a push's is the folder's, so every file
 * it did not touch is kept. Everything else about writing a folder, reading a
 * rendered file back before sending it, building the manifest, and the
 * `AGENTS.md` beside it, is the same work and is written once.
 */
type FileSource =
	| { readonly render: { readonly table: string; readonly rowId: string } }
	| {
			readonly keep: {
				readonly path: string;
				readonly contents: string;
				/** The entry it already had, carried forward with its bytes. */
				readonly entry: ManifestRow | undefined;
			};
	  };

/**
 * Write the folder, and the manifest describing exactly what was written.
 *
 * **A file and its entry are always made from the same bytes**, which is the
 * invariant this exists to hold in one place. A rendered file is read back
 * before it is sent, so the manifest cannot describe a file differently from
 * how the file will read; a kept file carries the entry it already had, so a
 * base never advances past a file that did not move.
 *
 * The set of paths is the whole checkout either way, because the host sweeps
 * what a checkout does not name (ADR-0337).
 */
async function writeFolder({
	data,
	definition,
	sources,
	kv,
	pulledAt,
	ifMatch,
	fetch: httpFetch,
}: {
	data: RenderableData & CheckoutAddress;
	definition: ParsedDataDefinition;
	sources: readonly FileSource[];
	/**
	 * The `kv.json` to write, and the settings base to record.
	 *
	 * Two facts rather than one. `contents` is `undefined` where the folder is
	 * to have no `kv.json`, and `values` is recorded either way: a folder whose
	 * file somebody deleted still has a base, and dropping it would read the
	 * file coming back as an edit to every setting in it.
	 */
	kv: {
		readonly contents: string | undefined;
		readonly values: JsonObject;
	};
	/** When the folder was last made current, which only a pull moves. */
	pulledAt: string;
	/** The folder this checkout was built against, which the host requires back. */
	ifMatch: string;
	fetch: typeof globalThis.fetch;
}): Promise<Result<{ files: number }, CheckoutError>> {
	const files: CheckoutFile[] = [];
	const failures: RenderError[] = [];
	const rows: Record<string, ManifestRow> = {};

	for (const source of sources) {
		if ('keep' in source) {
			const { path, contents, entry } = source.keep;
			files.push({ path, contents });
			const address = parseRowPath(path);
			// A file nobody ever pulled has no entry to carry, and should not be
			// given one: it is still a file nobody pulled, and the next plan says
			// so.
			if (address !== undefined && entry !== undefined) {
				rows[`${address.table}/${address.rowId}`] = entry;
			}
			continue;
		}
		const { table, rowId } = source.render;
		const rendered = await renderRow(data, definition, table, rowId);
		if (rendered.error !== null) {
			failures.push(rendered.error);
			continue;
		}
		// A render answers `undefined` for a row that is GONE. Every caller
		// enumerates rows it has just seen, so this is a row removed underneath
		// the walk, and a folder that never names it is the honest answer.
		if (rendered.data.contents === undefined) continue;
		const parsed = parseRowFile(rendered.data.contents);
		if (parsed === undefined) {
			failures.push(
				RenderError.BodyUnwritable({
					table,
					rowId,
					cause: 'the rendered file could not be read back',
				}).error,
			);
			continue;
		}
		files.push({ path: rendered.data.path, contents: rendered.data.contents });
		rows[`${table}/${rowId}`] = {
			values: parsed.fields,
			bodyHash: await contentHash(parsed.body),
		};
	}
	// Fail closed, and before anything is sent. A row missing from the folder
	// reads as a deletion at the next push, which is data deleted everywhere
	// (ADR-0325).
	if (failures.length > 0) return CheckoutError.Unrenderable({ failures });

	if (kv.contents !== undefined) {
		files.push({ path: 'kv.json', contents: kv.contents });
	}

	const manifest: CheckoutManifest = {
		dataId: data.dataId,
		generation: data.generation,
		baseURL: data.baseURL,
		principalId: data.principalId,
		pulledAt,
		rows,
		kv: kv.values,
	};
	files.push(
		{ path: AGENTS_PATH, contents: agentsFile(definition) },
		{ path: MANIFEST_PATH, contents: `${JSON.stringify(manifest, null, 2)}\n` },
	);

	const { error } = await sendCheckout(data.dataId, files, ifMatch, httpFetch);
	return error === null ? Ok({ files: files.length }) : Err(error);
}

/** Hand the whole checkout to the host, which replaces the folder with it. */
async function sendCheckout(
	dataId: string,
	files: readonly CheckoutFile[],
	/**
	 * The folder this checkout was prepared against.
	 *
	 * The host compares it in the same slot it sweeps in, so between this and
	 * the write nothing can land. A 412 is that refusal, and it means the same
	 * thing the module's own comparison means one layer up: what is there is not
	 * what somebody read.
	 */
	ifMatch: string,
	httpFetch: typeof globalThis.fetch,
): Promise<Result<void, CheckoutError>> {
	const { data: response, error } = await tryAsync({
		try: () =>
			httpFetch(checkoutUrl(dataId), {
				method: 'PUT',
				body: files.map(checkoutLine).join(''),
				credentials: 'same-origin',
				redirect: 'error',
				headers: {
					'content-type': 'application/x-ndjson',
					'if-match': ifMatch,
				},
			}),
		catch: (cause) => CheckoutError.HostUnreachable({ cause }),
	});
	if (error !== null) return Err(error);
	if (response.status === 412) {
		// The folder moved between the reading and this write. The caller reads
		// it again and shows the next list; this is the same refusal as the
		// comparison above, made by the side that holds the filesystem.
		return CheckoutError.FolderMoved();
	}
	if (!response.ok) {
		return CheckoutError.HostRefused({ status: response.status });
	}
	return Ok(undefined);
}

/** The absolute same-origin URL one database's working copy travels through. */
function checkoutUrl(dataId: string): string {
	return `${CHECKOUT_PATH}/${encodeURIComponent(dataId)}`;
}

/**
 * The store's writes a push needs, and nothing else.
 *
 * Structural, so an opened `ReplicaData` satisfies it without a cast and
 * without this module knowing the definition's field types. `transact` is here
 * because a push is one commit: a hundred fields across forty rows is one
 * durable append and one notification per table, and half a push landing is a
 * folder that matches nothing.
 */
export type PushableData = RenderableData & {
	/**
	 * The kv root's write, which a setting from `kv.json` goes through.
	 *
	 * `update` and not `set`, so a key nobody edited is left alone: the folder
	 * carries every setting on one file and a push touches the ones that moved.
	 */
	readonly kv: {
		update(values: JsonObject): void;
	};
	readonly tables: Readonly<
		Record<
			string,
			{
				/**
				 * Mint a row for a file nobody pulled, with its body already
				 * decoded.
				 *
				 * The node is integrated in this transaction and never again
				 * (ADR-0296), which is why it is passed rather than written
				 * afterwards. It THROWS rather than returning, on a reserved name
				 * or a node that already belongs to a document; `planPush` refuses
				 * both before a person ever sees the file.
				 */
				create(
					fields: JsonObject,
					body?: Y.Node,
				): {
					readonly id: string;
				};
				update(
					rowId: string,
					fields: JsonObject,
				): Result<void, { name: string; message: string }>;
				/**
				 * Take the row off the table, its body node and all.
				 *
				 * Returns nothing, because deleting an address that holds no row is
				 * a no-op fact rather than an outcome: another device may have
				 * deleted the same note between the plan and the push, and the
				 * result a person asked for is the one they get.
				 */
				delete(rowId: string): void;
			}
		>
	>;
	transact<TResult>(run: () => TResult): TResult;
};

/**
 * One thing a push does, and nothing it asks (ADR-0338).
 *
 * **Every difference between the folder and the store is one of these, and
 * the folder wins all of them.** A plan is what a person reads before one
 * approval, not a list of questions: a person whose agent rewrote the text of
 * eight notes was asked eight identical questions, and by the fourth was
 * clicking without reading. To change any of it, cancel, edit the file, and
 * push again, which is the loop the folder already is.
 *
 * What survives from the answerable draft is the comparison underneath it:
 * `base` from the manifest, `file` from disk, `store` from the database, per
 * field. It is what the overview prints, and the reason a value line carries
 * the store's old value: a value is safe because the old one can be typed
 * back, and a body's text is not.
 */
export type PlanItem =
	| PlannedValue
	| PlannedBody
	| PlannedAdmission
	| PlannedDeletion
	| PlannedKeep
	| PlannedSetting;

/**
 * One value the push sets, and the one it is replacing.
 *
 * **Nothing is validated on the way in** (ADR-0338). A name this table does
 * not declare and a value that does not fit its field are both written, and
 * the row is then one this release cannot read, which is a state the store
 * already has a word, a surface, and a record for (ADR-0125, ADR-0240).
 * Refusing them here made the folder a stricter door than `update`, `create`,
 * and every sync path.
 *
 * A value where all three of base, file, and store differ used to be its own
 * kind with its own question. It is this, with `storeChanged` true: the folder
 * still wins, and what a person is owed is being told the store's value is
 * going, which `store` prints.
 */
export type PlannedValue = {
	readonly kind: 'value';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	readonly name: string;
	/** What the store holds now, and what the overview prints beside it. */
	readonly store: JsonValue | undefined;
	/** What the file says, and what the push writes. */
	readonly file: JsonValue;
	/**
	 * Whether this value moved here too since the folder was written.
	 *
	 * The third side of the three-way, kept rather than asked about: with this
	 * false the store's value is the one the folder was written from, and with
	 * it true the push is overwriting an edit somebody made on this side.
	 */
	readonly storeChanged: boolean;
};

/**
 * One setting in `kv.json` the push writes, and the one it is replacing.
 *
 * Its own arm rather than a `PlannedValue` with an invented row id: a value
 * item is always about a row, and a renderer that had to special-case one
 * table name to print a setting is a second vocabulary for one item kind.
 *
 * Otherwise it is a value in every way that matters. The same three-way, the
 * same folder-wins rule, the same nothing-is-validated rule: an application
 * reads a setting as `kv.get(key) ?? DEFAULT`, and `get` already answers
 * `undefined` for a value this release cannot read, so a hand edit that does
 * not fit degrades to the default and shows in `nonconforming` (ADR-0125).
 *
 */
export type PlannedSetting = {
	readonly kind: 'setting';
	readonly path: 'kv.json';
	readonly name: string;
	/** What the store holds now, and what the overview prints beside it. */
	readonly store: JsonValue | undefined;
	/** What the file says, and what the push writes. */
	readonly file: JsonValue;
	/** Whether this setting moved here too since the folder was written. */
	readonly storeChanged: boolean;
};

/**
 * The text under one file's frontmatter changed (ADR-0329, amended by
 * ADR-0338).
 *
 * The table's codec rewrites the node the row already holds so that it says
 * what the file says. It is the file's whole text winning rather than a merge,
 * and no conflict marker is ever written into a file.
 *
 * This is the one item a person cannot put back by hand, which is why the
 * overview ranks it with the deletions: a value is printed beside its
 * replacement and can be typed back, and `rewrite` clears the node and the
 * editor's history with it.
 */
export type PlannedBody = {
	readonly kind: 'body';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
	/**
	 * Whether the row's own text moved here too since the folder was written.
	 *
	 * A three-way on the body, coarser than a value's because a hash is all the
	 * manifest keeps: with this false the push overwrites nothing anybody typed
	 * here, and with it true it does, which is a sentence the overview owes a
	 * person before they approve it.
	 */
	readonly storeChanged: boolean;
};

/**
 * A file the manifest never named, which becomes a row (ADR-0337).
 *
 * The push mints a row id, creates the row from the file's frontmatter with
 * its body decoded into the node, and the push writes it out at its id.
 * **So the file is renamed**, and there is no way around that: a row id is
 * minted and never chosen (`packages/app/src/data/store/handles.ts`), because two
 * devices creating one address produce two containers and one loses every
 * field in it. That was refused as rude while it was a silent side effect; it
 * is not rude when the overview says it before a person approves it.
 *
 * A person who wants neither cancels and renames the file out of the way,
 * which is the loop the folder already is.
 */
export type PlannedAdmission = {
	readonly kind: 'admission';
	readonly path: string;
	readonly table: string;
	/**
	 * The row this file used to be, where it had one and the store lost it.
	 *
	 * A file somebody edited whose note was deleted in the application. The
	 * folder wins, so it comes back, and it comes back as a NEW note under a
	 * new id, because a row id is minted and never chosen (ADR-0216). A
	 * surface owes a person that sentence rather than printing the path as
	 * though they had written the file from nothing.
	 */
	readonly replaces?: string;
};

/**
 * A file the manifest named and the folder no longer holds, which deletes the
 * row (ADR-0338).
 *
 * The base is what makes this a fact rather than a guess: `pull` wrote down
 * what it handed over, so a file that is gone is a file somebody removed.
 * ADR-0337 refused it for want of somewhere to put it, and the answer is that
 * there is nowhere to put it: **the row is deleted, and it does not pass
 * through the application's trash on the way.** Trashing a note through the
 * folder is setting `deletedAt` in the frontmatter, which is an ordinary value
 * edit. So both gestures exist and they are different, and the copy has to say
 * which one this is, because every other delete in an application like
 * Honeycrisp is recoverable and this one is not.
 *
 * No trash key on `TableDeclaration`: it would reserve a third key beside `id`
 * and `body` to teach the platform one application's trash view (ADR-0309,
 * ADR-0338).
 */
export type PlannedDeletion = {
	readonly kind: 'deletion';
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
};

/**
 * Something in this file the push cannot carry, so the push leaves it alone.
 *
 * **One reason, and it is not always the whole file.** Four of the five stop
 * the file dead, and `body-unreadable` does not: a body this table's codec
 * refuses is one region, and the values in the same frontmatter are ordinary
 * values that go in beside it. That is ADR-0338's rule rather than an
 * exception to it, because everything the folder can express lands and only
 * what cannot be read is written over.
 *
 * It carried a LIST of reasons, each with an optional field name, for a file
 * that might have several things wrong with it. Nothing ever wrote the second
 * one: every site passes a reason alone and then stops looking, so the list
 * was always one long and the name was never set.
 *
 * What is wrong is said so a person can cancel, fix it, and read the folder
 * again, which costs nothing.
 */
export type PlannedKeep = {
	readonly kind: 'kept';
	readonly path: string;
	readonly reason: KeepReason;
};

export type KeepReason =
	/**
	 * `kv.json` is not one JSON object, so there are no settings to read out.
	 *
	 * The same rule a row file follows: a file this side cannot read is left
	 * exactly as the person wrote it, and the repair is the file (ADR-0341).
	 */
	| 'kv-unreadable'
	/**
	 * The row is there and this release cannot write it out.
	 *
	 * A codec that throws, or a row whose shape `render.ts` refuses. Its own
	 * reason rather than `unreadable`, because the file is fine and telling
	 * somebody to fix a `---` block that is not broken sends them at the wrong
	 * thing: what cannot be read is the NOTE.
	 */
	| 'row-unwritable'
	/** The frontmatter frame is gone, so nothing here can be read. */
	| 'unreadable'
	/**
	 * The definition no longer declares this table.
	 *
	 * Its rows still render (ADR-0240), so they are in the folder and in the
	 * manifest, and there is no handle to write one through.
	 */
	| 'table-undeclared'
	/**
	 * The table's codec refused the text under the fence.
	 *
	 * Checked with `decode`, which validates the same text `rewrite` would
	 * apply, so a person never reads a plan whose own push then refuses it.
	 */
	| 'body-unreadable';

/** What a push does, item by item (ADR-0338). */
export type PushPlan = readonly PlanItem[];

/**
 * Where one item sits in a plan, and the order a person reads it in.
 *
 * The path and item kind, plus the field where the item is about one.
 * A value field named body and a body edit have distinct sort keys.
 *
 * It is a sort key rather than an identity: a plan is sorted by it so that
 * `samePlan` compares two readings of the same folder rather than two
 * directory listings.
 */
function planKey(item: PlanItem): string {
	switch (item.kind) {
		case 'value':
		case 'setting':
			return `${item.path}#${item.kind}#${item.name}`;
		case 'body':
			return `${item.path}#body`;
		case 'admission':
		case 'deletion':
		case 'kept':
			return `${item.path}#${item.kind}`;
	}
}

/**
 * What a pull writes, and what it declined to write.
 *
 * `declined` is not a failure: a person reading the list and saying no is the
 * verb working. It is a status rather than an error so a surface does not have
 * to tell a refusal from a decision (`error-handling`).
 */
export type PullResult =
	| { readonly status: 'applied'; readonly files: number }
	| { readonly status: 'declined' };

/**
 * What a push changed, or why it changed nothing.
 *
 * `unchanged` is an empty plan, and `confirm` is not called for it: there is
 * nothing to approve, and a dialog listing no changes is a question with one
 * answer. `declined` is a person saying no to a list that had something in it.
 */
export type PushResult =
	| ({ readonly status: 'applied' } & PushOutcome)
	| { readonly status: 'declined' }
	| { readonly status: 'unchanged' };

/**
 * The `~/Epicenter/<data-id>/` folder, bound to one opened store (ADR-0337).
 *
 * Two verbs, and each is the whole human sequence: read the folder, show it,
 * take one approval, read it again, and apply only what was approved
 * (ADR-0341). Nothing in between is a caller's to hold. A plan used to travel
 * out to a dialog and back into a verb, and every surface that offered the
 * button rebuilt the same "it moved while you were reading" loop by hand.
 *
 * There is no `diff`. A `confirm` that records its preview and returns `false`
 * is one, and it cannot drift from what the verbs compare, because it IS what
 * they compare.
 */
export type WorkingCopy = {
	/**
	 * Write every file in the folder from these notes, after one approval.
	 *
	 * The destructive direction: it writes over everything in the preview, so
	 * confirming the list IS the discard. `confirm` is asked on every pull
	 * including one with nothing to lose, because a pull always writes; a
	 * surface that does not want a dialog for an empty list answers `true`
	 * without showing one.
	 */
	pull(options: {
		confirm: Confirm<PullPreview>;
	}): Promise<Result<PullResult, CheckoutError>>;
	/**
	 * Apply the folder's edits to the notes, then write back what it touched.
	 *
	 * The folder wins, whole, and nothing is validated on the way in
	 * (ADR-0338). To change any of it, a person cancels, edits the file, and
	 * pushes again.
	 */
	push(options: {
		confirm: Confirm<PushPreview>;
	}): Promise<Result<PushResult, CheckoutError>>;
};

/**
 * Bind the folder to this store.
 *
 * The store states its own address (ADR-0340), so this takes one argument and
 * there is nothing for a caller to get half right. It holds no resources: the
 * host owns the folder and the exclusion, and this side owns one question at a
 * time, which is what `busy` below refuses a second of.
 */
export function createWorkingCopy(
	data: PushableData & CheckoutAddress,
	{
		fetch: httpFetch = globalThis.fetch,
		now = () => new Date(),
	}: { fetch?: typeof globalThis.fetch; now?: () => Date } = {},
): WorkingCopy {
	const dataId = data.dataId;

	/**
	 * Read, ask, read again, and apply only if nothing moved.
	 *
	 * The loop is here rather than at the call site because it is the guard: a
	 * surface that rebuilt it could forget the second reading, and the failure
	 * would be silent and destructive.
	 *
	 * A turn either costs an approval or follows a folder that really moved, so
	 * it needs no count: an agent that keeps writing produces an honest "it
	 * moved again" rather than a spin, and a host that refuses the reading it
	 * just handed back is an error rather than another turn. That second one is
	 * what bounds a `confirm` that answers without asking anybody.
	 */
	async function run<TPreview, TResult>({
		preview,
		confirm,
		apply,
	}: {
		preview: (found: {
			held: FolderContents;
			read: Reading;
		}) => Result<TPreview | undefined, CheckoutError>;
		confirm: Confirm<TPreview>;
		apply: (found: {
			held: FolderContents;
			read: Reading;
		}) => Promise<Result<TResult, CheckoutError>>;
	}): Promise<Result<TResult | { status: 'declined' }, CheckoutError>> {
		let found = await readFolder(data, data.definition, httpFetch);
		if (found.error !== null) return Err(found.error);
		let stale = false;

		for (;;) {
			const shown = preview(found.data);
			if (shown.error !== null) return Err(shown.error);
			// `undefined` is a verb with nothing to do, which is not a question.
			if (shown.data === undefined) {
				return (await apply(found.data)) as Result<TResult, CheckoutError>;
			}
			if (!(await confirm(shown.data, { stale }))) {
				return Ok({ status: 'declined' as const });
			}

			// The second reading, and the reason a preview is never an input: what
			// gets applied is this, not what the caller was holding.
			const again = await readFolder(data, data.definition, httpFetch);
			if (again.error !== null) return Err(again.error);
			if (!sameReading(found.data, again.data)) {
				found = again;
				stale = true;
				continue;
			}
			const applied = await apply(again.data);
			// The host refused the write because the folder moved between this
			// reading and the write itself. Nothing landed, so it is the same loop
			// one turn later rather than a failure. A push that already committed
			// to the store reports `FolderStale` instead and never reaches here.
			if (applied.error?.name === 'FolderMoved') {
				const next = await readFolder(data, data.definition, httpFetch);
				if (next.error !== null) return Err(next.error);
				// The folder the host refused is the folder it just handed back,
				// so the two sides disagree about what a reading names and no
				// number of turns will fix it. This is what bounds the loop when
				// nobody is clicking: every other turn either costs an approval or
				// follows a folder that really moved.
				if (next.data.held.etag === again.data.held.etag) {
					return Err(applied.error);
				}
				found = next;
				stale = true;
				continue;
			}
			return applied;
		}
	}

	return {
		async pull({ confirm }) {
			if (inUse.has(dataId)) return CheckoutError.Busy();
			inUse.add(dataId);
			try {
				return await run<PullPreview, PullResult>({
					// Always a question. A pull writes over the folder whatever the
					// list says, so there is no arm here that skips the approval.
					preview: ({ read }) => Ok(previewOf(read)),
					confirm,
					apply: async ({ held }) => {
						const written = await applyPull({
							data,
							held,
							fetch: httpFetch,
							now,
						});
						return written.error === null
							? Ok({ status: 'applied' as const, files: written.data.files })
							: Err(written.error);
					},
				});
			} finally {
				inUse.delete(dataId);
			}
		},
		async push({ confirm }) {
			if (inUse.has(dataId)) return CheckoutError.Busy();
			inUse.add(dataId);
			try {
				return await run<PushPreview, PushResult>({
					preview: ({ read }) => {
						if (read.base === undefined) {
							return CheckoutError.FolderUnwritten();
						}
						// Nothing to send and nothing to ask. Not `declined`: nobody
						// declined anything, the folder simply matches the notes.
						if (read.plan.length === 0) return Ok(undefined);
						return Ok({ plan: read.plan });
					},
					confirm,
					apply: async ({ held, read }) => {
						if (read.base === undefined) {
							return CheckoutError.FolderUnwritten();
						}
						if (read.plan.length === 0) {
							return Ok({ status: 'unchanged' as const });
						}
						const applied = await applyPush({
							data,
							held,
							base: read.base,
							plan: read.plan,
							fetch: httpFetch,
						});
						return applied.error === null
							? Ok({ status: 'applied' as const, ...applied.data })
							: Err(applied.error);
					},
				});
			} finally {
				inUse.delete(dataId);
			}
		},
	};
}

/**
 * Which folders have a verb between a preview and its write.
 *
 * Keyed by data id rather than kept on the object, because there is one folder
 * per store however many working copies an application builds over it. A
 * surface with a pull button and a push button in two components would
 * otherwise hold two flags and guard nothing.
 */
const inUse = new Set<string>();

/**
 * Whether two readings are the same folder and the same answer about it.
 *
 * Two facts, because they cover different sides. The `etag` is the host's
 * statement about the whole folder, so it catches a file whose text moved
 * without changing which items the plan holds: an agent editing the same
 * paragraph twice used to need a hash on the item itself, and the folder's own
 * identity answers it for every file at once. The preview catches the other
 * side, where the folder held still and a note moved in the application.
 */
function sameReading(
	left: { held: FolderContents; read: Reading },
	right: { held: FolderContents; read: Reading },
): boolean {
	return (
		left.held.etag === right.held.etag &&
		samePreview(previewOf(left.read), previewOf(right.read))
	);
}

/**
 * The one comparison, and what a person is shown before either verb runs.
 *
 * The three-way is per field and lives only here: `base` from the manifest,
 * `file` from disk, `store` from the database now.
 *
 * | base, file, store | what happens |
 * | --- | --- |
 * | `file == base` | the person did not touch it; the store's value stands |
 * | `store == base` | apply the file's value |
 * | `store == file` | already converged; nothing to do |
 * | all three differ | the file's value, and the overview says the store moved |
 *
 * All three sides go through the same round trip. `base` and `file` came out of
 * `frontmatter.ts`, and `store` is rendered and parsed back here rather than
 * read off the row, so a value that survives the file format identically on two
 * sides compares identically. Reading the row directly meant guessing which
 * members were nodes, and a JSON object that happened to look like one was
 * dropped and then read as a conflict.
 *
 * It changes nothing and reaches nothing live, including for the two items
 * that would. An admission is checked by DECODING the file, which builds a
 * detached node and throws it away; a body is checked the same way, because
 * `decode` validates the text `rewrite` would apply and `rewrite` would edit
 * the store. That is what lets a plan be JSON a dialog can hold and a push can
 * compare against, and it is why `push` decodes a second time rather than
 * carrying a live node through the plan a person reads.
 */
async function planPush(
	data: RenderableData,
	definition: ParsedDataDefinition,
	held: FolderContents,
): Promise<Reading> {
	const items: PlanItem[] = [];
	const base = held.base;

	// **A folder nothing wrote is not a plan** (ADR-0338). Never pulled,
	// manifest deleted, manifest mangled, or manifest written by another
	// account: with no base, every file here might be work nobody has ever
	// sent, and there is no comparison to print. It is one fact about the
	// folder rather than one item per file, because the answer to all of them
	// is the same and it is `pull`.
	if (base === undefined) {
		// Sorted for the reason the plan is: a person approves this list and a
		// verb compares what it reads against it, and the host's directory order
		// is the filesystem's business.
		const unwritten = [...held.files.keys()]
			.filter((path) => parseRowPath(path) !== undefined || path === 'kv.json')
			.sort();
		return { base: undefined, unwritten };
	}

	const onDisk = held.files.get('kv.json');
	if (onDisk !== undefined) {
		const inFile = readSettings(onDisk);
		if (inFile === undefined) {
			items.push({ kind: 'kept', path: 'kv.json', reason: 'kv-unreadable' });
		} else {
			const inStore = data.stored().kv;
			// The same three-way and the same loop a row's values run, over the
			// union of what was handed over and what the file says now. A key only
			// the store holds and the person never touched says nothing, which is
			// what makes a setting this release added silent in an old folder.
			for (const name of new Set([
				...Object.keys(base.kv),
				...Object.keys(inFile),
			])) {
				const wrote = inFile[name] ?? null;
				const wasHandedOver = base.kv[name];
				const held = inStore[name];
				if (same(wrote, wasHandedOver)) continue;
				if (same(wrote, held)) continue;
				items.push({
					kind: 'setting',
					path: 'kv.json',
					name,
					store: held,
					file: wrote,
					storeChanged: !same(held, wasHandedOver),
				});
			}
		}
	}

	for (const [key, handed] of Object.entries(base.rows)) {
		const address = parseRowPath(`${key}${ROW_FILE_EXTENSION}`);
		if (address === undefined) continue;
		const path = rowPath(address.table, address.rowId);
		const keep = (reason: KeepReason) =>
			items.push({ kind: 'kept', path, reason });

		const contents = held.files.get(path);
		if (contents === undefined) {
			// The base is what makes this a deletion rather than a guess: `pull`
			// wrote down that it handed this file over, so its absence is
			// somebody removing it (ADR-0338).
			const declared = definition.tables.get(address.table);
			if (declared === undefined) {
				// No handle to delete through, and its rows still render
				// (ADR-0240), so the next pull puts this file back. That is what a
				// keeping is, and it is the honest thing to say about a table this
				// release no longer declares.
				keep('table-undeclared');
				continue;
			}
			// `rowFile` rather than `renderedRow`: what is asked here is whether
			// the row is THERE, and a render also answers `undefined` for a row
			// that is present and cannot be written (`render.ts`). Under
			// ADR-0338 an unwritable row is ordinary, and deleting its file
			// still means delete it.
			if (data.rowFile(address.table, address.rowId) === undefined) {
				// The row went while the file did. Both sides already agree, so
				// there is nothing to say and nothing to delete.
				continue;
			}
			items.push({ kind: 'deletion', path, ...address });
			continue;
		}
		const file = readRowFile(contents);
		if (file === undefined) {
			keep('unreadable');
			continue;
		}
		// **A file nobody touched says nothing, whatever the store did.** The
		// same rule the value three-way applies per field ("the person did not
		// touch it; the store's value stands"), applied one level up, at the
		// file. Without it, deleting a note in the application made the NEXT
		// pull refuse: the store was consulted first, the row was gone, and a
		// file the person had never opened was reported as work they were about
		// to lose.
		//
		// It is also the only real cost win in this pass. An untouched folder
		// is the common case, and it now costs one hash per file rather than a
		// render and a codec `encode` per row.
		if (await untouched(file, handed)) continue;
		const table = definition.tables.get(address.table);
		if (table === undefined) {
			keep('table-undeclared');
			continue;
		}
		// **A file somebody edited whose note is gone comes back as a note**
		// (ADR-0341). The folder wins, and there is nothing here to win against:
		// the store has no row, so this is a file nobody pulled, which is an
		// admission and mints an id like any other. It fires only because the
		// file was touched, since the gate above already dropped every file
		// identical to its base, which is what keeps this from being the
		// resurrecting folder ADR-0337 refused.
		//
		// `rowFile` rather than the render: a render also answers `undefined`
		// for a row that is present and cannot be written, and that row is
		// still there to be updated.
		if (data.rowFile(address.table, address.rowId) === undefined) {
			const back = await admission(definition, address.table, path, contents);
			items.push(
				back.kind === 'admission' ? { ...back, replaces: address.rowId } : back,
			);
			continue;
		}
		const stored = await renderedRow(data, definition, address);
		if (stored === undefined) {
			// Present and unwritable, which `pull` fails closed on and a push has
			// no values to compare against. The file stays as it is.
			keep('row-unwritable');
			continue;
		}

		// The body is one item beside the values rather than instead of them.
		// It used to refuse the row outright, so one edited paragraph hid every
		// value edit in the same file from the person deciding.
		const inFile = await contentHash(file.body);
		if (inFile !== handed.bodyHash) {
			const inStore = await contentHash(stored.body);
			if (inStore !== inFile) {
				if (!readsBack(table, file.body)) {
					keep('body-unreadable');
				} else {
					items.push({
						kind: 'body',
						path,
						...address,
						storeChanged: inStore !== handed.bodyHash,
					});
				}
			}
		}

		for (const name of new Set([
			...Object.keys(handed.values),
			...Object.keys(file.fields),
		])) {
			// **A removed line is `null`, and nothing here validates** (ADR-0338).
			// The file format already decided the first: `frontmatter.ts` writes
			// `null` for an absent value and for `null` alike, so a line deleted
			// by hand reads as the value it would have read as if it were typed.
			// The second is that a name this table does not declare and a value
			// that does not fit its field are what `update` itself admits
			// (ADR-0125, ADR-0240); refusing them here made the folder a stricter
			// door than every other way into the store.
			const wrote = file.fields[name] ?? null;
			const wasHandedOver = handed.values[name];
			const inStore = stored.fields[name];
			if (same(wrote, wasHandedOver)) continue;
			if (same(wrote, inStore)) continue;

			items.push({
				kind: 'value',
				path,
				...address,
				name,
				store: inStore,
				file: wrote,
				storeChanged: !same(inStore, wasHandedOver),
			});
		}
	}

	for (const [path, contents] of held.files) {
		const address = parseRowPath(path);
		if (address === undefined) continue;
		if (base.rows[`${address.table}/${address.rowId}`] !== undefined) continue;
		items.push(await admission(definition, address.table, path, contents));
	}

	// Sorted, because `push` compares the plan a person read against one it
	// computes again and a different ORDER would read as a different plan. Two
	// of the three sources are already deterministic; the third is the host's
	// directory listing, whose order is the filesystem's business.
	return {
		base,
		plan: items.sort((left, right) =>
			planKey(left) < planKey(right) ? -1 : 1,
		),
	};
}

/**
 * What one reading of the folder found: a plan, or no base to plan against.
 *
 * Two shapes rather than a plan holding a refusal, because the two verbs
 * answer them differently. A push refuses an unwritten folder, because nothing
 * in it can be told from what the store already has. A pull writes over it,
 * and the paths are what it owes a person before they say yes.
 */
type Reading =
	| { readonly base: CheckoutManifest; readonly plan: PushPlan }
	| { readonly base: undefined; readonly unwritten: readonly string[] };

/**
 * What a pull is about to write over, as a person reads it before saying yes.
 *
 * `unwritten` is a folder nothing here ever wrote, where there is nothing to
 * compare and every row-shaped file might be work nobody has sent. It is an
 * arm of the PULL preview and not of the push one, because the two directions
 * answer it differently: a pull sweeps those files, and a push has no base to
 * tell an edit from a file that was always there, so it refuses.
 *
 * **An output, never an input.** It is handed to `confirm` and never handed
 * back: what a person approves is the reading the working copy is holding, and
 * nothing a caller keeps can stand in for it.
 */
export type PullPreview =
	| { readonly base: true; readonly plan: PushPlan }
	| { readonly base: false; readonly unwritten: readonly string[] };

/**
 * What a push is about to change in the notes.
 *
 * No `base` arm: a push against a folder nothing wrote is `FolderUnwritten`
 * before a person is shown anything, because there is no comparison to print.
 */
export type PushPreview = { readonly plan: PushPlan };

/**
 * The one question either verb asks, answered `true` or `false`.
 *
 * It runs before anything is written, so a throw from here is a bug in the
 * surface rather than an outcome, and it escapes as a rejection rather than
 * being folded into a `Result`.
 *
 * `stale` is true when this list replaced one the person already read: the
 * folder or the notes moved while they were looking, so nothing was applied
 * and this is what is true now. A surface says so rather than apologising.
 */
export type Confirm<TPreview> = (
	preview: TPreview,
	context: { readonly stale: boolean },
) => Promise<boolean>;

/**
 * Whether this file still says exactly what `pull` handed over.
 *
 * Both halves, because both are what was handed over: every value the manifest
 * recorded, compared the way the push compares them, and the body against its
 * hash. Absent and `null` are the same value here for the same reason they are
 * everywhere else in this module (`same`), so a line deleted from a file that
 * recorded `null` is still untouched.
 */
async function untouched(
	file: ParsedRowFile,
	handed: { values: JsonObject; bodyHash: string },
): Promise<boolean> {
	for (const name of new Set([
		...Object.keys(handed.values),
		...Object.keys(file.fields),
	])) {
		if (!same(file.fields[name] ?? null, handed.values[name])) return false;
	}
	return (await contentHash(file.body)) === handed.bodyHash;
}

/**
 * Whether this table's codec can read this text, with a throw counted as no.
 *
 * A codec is application code run over a file a person hand-edited, and
 * `readArtifact` already treats a throw from one as data rather than as a
 * crash. A plan that let one escape would make the preview REJECT on a folder,
 * which is the one thing a person has to be able to look at.
 *
 * It is also the promise `rewrite` is applied under: a push validates a body
 * by decoding it here and rewrites with the same text after the approval,
 * so a codec whose two readers disagreed would show a plan its own push
 * refuses.
 *
 * A table without a codec cannot read body text back. Its field edits remain
 * independent of this body check.
 */
function readsBack(table: ParsedTable, text: string): boolean {
	const codec = table.body;
	if (codec === undefined) return false;
	try {
		return codec.decode(text).error === null;
	} catch {
		return false;
	}
}

/**
 * A file nobody pulled, as the row it would become or as the reason it cannot.
 *
 * Three things stop a file from becoming a row, and every one of them is the
 * file being unreadable rather than the row being wrong. A definition declares
 * no defaults (ADR-0255), so a file missing half its fields mints a row this
 * release reads as nonconforming, which is a state the store already has a
 * word, a surface, and a record for (ADR-0125, ADR-0338). It is written, and
 * the note list shows it.
 */
async function admission(
	definition: ParsedDataDefinition,
	tableName: string,
	path: string,
	contents: string,
): Promise<PlannedAdmission | PlannedKeep> {
	const table = definition.tables.get(tableName);
	if (table === undefined) {
		return { kind: 'kept', path, reason: 'table-undeclared' };
	}
	const file = readRowFile(contents);
	if (file === undefined) {
		return { kind: 'kept', path, reason: 'unreadable' };
	}
	// A missing codec accepts only empty text. A declared codec owns empty
	// text too, so preview and commit make the same admission decision.
	if (
		(table.body === undefined && file.body !== '') ||
		(table.body !== undefined && !readsBack(table, file.body))
	) {
		return { kind: 'kept', path, reason: 'body-unreadable' };
	}
	return { kind: 'admission', path, table: tableName };
}

/**
 * File values cannot overwrite row identity or the live body node.
 * All other names, including undeclared and !-prefixed fields, round-trip.
 */
function readRowFile(contents: string): ParsedRowFile | undefined {
	const file = parseRowFile(contents);
	if (file === undefined) return undefined;
	const fields: JsonObject = {};
	for (const [name, value] of Object.entries(file.fields)) {
		if (name === 'id') continue;
		fields[name] = value;
	}
	return { fields, body: file.body };
}

/**
 * Whether two values are the same, by exact JSON identity, key order included.
 *
 * Every side is JSON that `JSON.stringify` emitted or `JSON.parse` read back:
 * a row's through `frontmatter.ts`, a setting's through `kv.json`. So
 * serializing to compare is the same round trip the file already made. Absent
 * and `null` compare equal, because that is what both emitters write for both.
 *
 * Key order counts, so an object value whose keys a person reordered by hand
 * reads as an edit. `frontmatter.ts` sorts the top level and no deeper, and
 * the folder wins either way, so what this costs is one line in an overview
 * rather than a wrong answer.
 */
function same(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * One row's file as the folder would read it, or `undefined` when the row is
 * gone.
 *
 * Rendered and parsed back rather than read off the row, so the store's side of
 * the comparison made the same trip the other two did. Both halves, because
 * both are compared now: the values against the manifest's values, and the
 * body against a hash of what was handed over.
 */
async function renderedRow(
	data: RenderableData,
	definition: ParsedDataDefinition,
	address: { table: string; rowId: string },
): Promise<{ fields: JsonObject; body: string } | undefined> {
	const rendered = await renderRow(
		data,
		definition,
		address.table,
		address.rowId,
	);
	if (rendered.error !== null || rendered.data.contents === undefined) {
		return undefined;
	}
	return parseRowFile(rendered.data.contents);
}

/**
 * Read the folder and say what it holds that the notes do not.
 *
 * The one reading, so what a person is shown is exactly what the verb compares
 * against afterwards. It was written three times, and three copies of a guard
 * is three chances for a surface to approve one thing while a verb applies
 * another.
 */
async function readFolder(
	data: RenderableData & CheckoutAddress,
	definition: ParsedDataDefinition,
	httpFetch: typeof globalThis.fetch,
): Promise<Result<{ held: FolderContents; read: Reading }, CheckoutError>> {
	const held = await readWorkingCopy(data, httpFetch);
	if (held.error !== null) return Err(held.error);
	return Ok({
		held: held.data,
		read: await planPush(data, definition, held.data),
	});
}

/** The reading, as a surface reads it: the manifest itself is nobody else's. */
function previewOf(read: Reading): PullPreview {
	return read.base === undefined
		? { base: false, unwritten: read.unwritten }
		: { base: true, plan: read.plan };
}

/**
 * Whether the folder is still the one somebody approved.
 *
 * Both arms are sorted where they are built, so identity is the comparison and
 * a folder read twice is the same folder.
 */
function samePreview(left: PullPreview, right: PullPreview): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply the folder, whole, then write back the files it touched (ADR-0341).
 *
 * **One approval, and the folder wins.** There is nothing to answer: a value
 * goes in whatever it says, a body replaces the text that was there, a new
 * file becomes a note, and a file that is gone deletes one. To change any of
 * it, a person cancels, edits the file, and pushes again, which is the loop
 * the folder already is.
 *
 * **It takes the plan a person read and checks it is still the plan.** That is
 * now the only guard, and it is not about consent to an item: an agent may
 * still be working while the overview is open (ADR-0330), and applying a
 * different list is applying a change nobody read. When it has changed, the
 * refusal carries what is true now, so a surface shows the new plan rather
 * than an apology.
 *
 * One transaction for all of it: the deletions, the values, the bodies, and
 * the rows a file brought into being. A hundred fields across forty rows is
 * one durable append and one notification per table, and half a push landing
 * is a folder that matches nothing.
 */
async function applyPush({
	data,
	held,
	base,
	plan,
	fetch: httpFetch,
}: {
	data: PushableData & CheckoutAddress;
	/** The reading a person approved, re-read and found unmoved. */
	held: FolderContents;
	base: CheckoutManifest;
	plan: PushPlan;
	fetch: typeof globalThis.fetch;
}): Promise<Result<PushOutcome, CheckoutError>> {
	const settings = appliedSettings(plan);
	const outcome = {
		rows: 0,
		values: 0,
		settings: 0,
		bodies: 0,
		deleted: 0,
		admitted: [],
	} as {
		rows: number;
		values: number;
		settings: number;
		bodies: number;
		deleted: number;
		admitted: Admitted[];
	};
	let failure: { name: string; message: string } | undefined;
	const broke = (message: string) => {
		failure ??= { name: 'PlanUnapplied', message };
	};

	// **Every node is built before the transaction opens.** `decode` is
	// application code over a file a person hand-edited: it can refuse and it
	// can throw, and either inside the commit would leave half a push written
	// and escape as a rejected promise rather than as this function's error.
	// A detached node costs nothing to build and throw away, so the fallible
	// half happens where nothing has been written yet.
	const admitting: {
		item: PlannedAdmission;
		fields: JsonObject;
		node: Y.Node | undefined;
	}[] = [];
	for (const item of plan) {
		if (item.kind !== 'admission') continue;
		const file = readRowFile(held.files.get(item.path) ?? '');
		if (file === undefined) {
			broke(`'${item.path}' could not be read into a row`);
			continue;
		}
		const codec = data.definition.tables.get(item.table)?.body;
		// No codec and an empty body is a row whose file IS its frontmatter,
		// and `create` mints the empty node for it. A body with no codec was
		// already kept at plan time.
		if (codec === undefined) {
			admitting.push({ item, fields: file.fields, node: undefined });
			continue;
		}
		const built = trySync({
			try: () => codec.decode(file.body),
			catch: (cause) => Err({ name: 'CodecThrew', message: String(cause) }),
		});
		if (built.error !== null || built.data.error !== null) {
			broke(`'${item.path}' could not be read into a row`);
			continue;
		}
		admitting.push({ item, fields: file.fields, node: built.data.data });
	}
	if (failure !== undefined) return unapplied(failure);

	// One commit for the values, the bodies, and the rows a file brought into
	// being. A throw from here is contained rather than allowed to escape: the
	// store commits what a throwing `run` already wrote, so an escaping one
	// would leave a folder that matches neither side and a caller with a
	// rejected promise instead of an outcome.
	const ran = trySync({
		try: () =>
			data.transact(() => {
				// Deletions before anything else, so the commit reads in the same
				// order the overview does: what is gone for good, then what
				// changed. Nothing else in the plan can name a deleted row, since
				// every other item is made from a file that is still there.
				for (const item of plan) {
					if (item.kind !== 'deletion') continue;
					const table = data.tables[item.table];
					if (table === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					table.delete(item.rowId);
					outcome.deleted += 1;
				}

				// The settings, one write however many keys moved, for the same
				// reason a row's are. `update` merges, so a key nobody touched is
				// left alone rather than cleared.
				const moved = Object.keys(settings).length;
				if (moved > 0) {
					data.kv.update(settings);
					outcome.settings += moved;
				}

				// Values gathered per row, because a row is one write however many
				// of its fields moved.
				const perRow = new Map<
					string,
					{ item: PlannedValue; fields: JsonObject }
				>();
				for (const item of plan) {
					if (item.kind !== 'value') continue;
					const held = perRow.get(item.path) ?? { item, fields: {} };
					held.fields[item.name] = item.file;
					perRow.set(item.path, held);
				}
				for (const { item, fields } of perRow.values()) {
					// The table is there: `planPush` kept every file whose
					// table this definition does not declare, and this runs with
					// no await since the plan was made.
					const written = data.tables[item.table]?.update(item.rowId, fields);
					if (written === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					if (written.error !== null) {
						failure ??= written.error;
						continue;
					}
					outcome.values += Object.keys(fields).length;
					outcome.rows += 1;
				}

				for (const item of plan) {
					if (item.kind !== 'body') continue;
					const node = data.rowFile(item.table, item.rowId)?.body;
					const codec = data.definition.tables.get(item.table)?.body;
					// Both are defensive: a row with no live node renders as
					// `MalformedRow`, so `planPush` already kept it,
					// and a body item is only made where a codec read the text.
					if (!(node instanceof Y.Node) || codec === undefined) {
						broke(`'${item.path}' has no live node to rewrite`);
						continue;
					}
					// The node the row already holds, edited rather than replaced,
					// so an editor bound to this very note is still bound after
					// (ADR-0338). The text was decoded once at plan time to prove
					// the codec accepts it; a live node is not JSON, so it could
					// not travel through the plan a person read.
					const { error } = codec.rewrite(node, bodyOf(held, item.path));
					if (error !== null) {
						failure ??= error;
						continue;
					}
					outcome.bodies += 1;
				}

				for (const { item, fields, node } of admitting) {
					// The id is minted here and the file is renamed to it by the
					// write below. `create` integrates the node in the
					// transaction that mints the row, which is the only moment a
					// nested type may arrive (ADR-0296).
					const created = data.tables[item.table]?.create(fields, node);
					if (created === undefined) {
						broke(`no table '${item.table}'`);
						continue;
					}
					outcome.admitted.push({
						path: item.path,
						table: item.table,
						rowId: created.id,
					});
				}
			}),
		catch: (cause) => Err({ name: 'PlanUnapplied', message: String(cause) }),
	});
	if (ran.error !== null) failure ??= ran.error;

	// Not swallowed. Everything above was checked against a plan read a moment
	// ago inside the same synchronous stretch, so reaching this means an
	// invariant broke rather than a person did something. The writes that
	// landed still stand; what is reported is that not all of them did.
	if (failure !== undefined) return unapplied(failure);

	// The folder goes back as it was, with the files this push touched replaced
	// (ADR-0341). Not a re-render: a file the push could not read is untouched
	// because the push only writes what it touched, and a change another device
	// made reaches this folder at the next pull rather than under the person's
	// hands.
	// A path the plan could not read in full is never rendered again, whatever
	// else the push took from it. A file whose values landed and whose body the
	// codec refuses is the case: re-rendering it would destroy the text the
	// person typed in the same act that carried their value, which is the loss
	// ADR-0341 exists to end.
	const kept = new Set(
		plan.flatMap((item) => (item.kind === 'kept' ? [item.path] : [])),
	);
	const touched = [
		...new Map(
			plan.flatMap((item) =>
				(item.kind === 'value' || item.kind === 'body') && !kept.has(item.path)
					? [[item.path, { table: item.table, rowId: item.rowId }] as const]
					: [],
			),
		).values(),
		...outcome.admitted.map(({ table, rowId }) => ({ table, rowId })),
	];
	// The name a person gave a file that became a row. The row lives at its
	// minted id now, so the old path is not sent and the host sweeps it. A
	// deleted row needs no entry here: its file was already gone, which is what
	// made it a deletion.
	const dropped = new Set(outcome.admitted.map(({ path }) => path));
	// The values this push wrote, by path, so a file it kept can still record
	// what LANDED. A kept file is one the push took something from and did not
	// rewrite: the body was unreadable, the values were not.
	const applied = new Map<string, JsonObject>();
	for (const item of plan) {
		if (item.kind !== 'value') continue;
		applied.set(item.path, {
			...applied.get(item.path),
			[item.name]: item.file,
		});
	}
	// The folder's own set of paths, with the rows this push wrote rendered
	// again and everything else kept exactly as it was.
	const rendered = new Set(
		touched.map(({ table, rowId }) => rowPath(table, rowId)),
	);
	const sources: FileSource[] = [];
	for (const [path, contents] of held.files) {
		if (path === AGENTS_PATH || path === MANIFEST_PATH || path === 'kv.json') {
			continue;
		}
		if (dropped.has(path) || rendered.has(path)) continue;
		const address = parseRowPath(path);
		// Not a place a checkout owns, so not this write's to send. The host
		// leaves it alone either way.
		if (address === undefined) continue;
		sources.push({
			keep: { path, contents, entry: carried(base, address, applied) },
		});
	}
	for (const address of touched) {
		// A row this push wrote and then could not find is an invariant break,
		// and the folder is not where to report it: rendering nothing would have
		// the host sweep a file the person edited, so it goes back as it was.
		if (data.rowFile(address.table, address.rowId) === undefined) {
			const path = rowPath(address.table, address.rowId);
			const contents = held.files.get(path);
			if (contents !== undefined) {
				sources.push({
					keep: {
						path,
						contents,
						entry: base.rows[`${address.table}/${address.rowId}`],
					},
				});
			}
			continue;
		}
		sources.push({ render: address });
	}
	const kvContents = held.files.get('kv.json');
	const written = await writeFolder({
		data,
		definition: data.definition,
		sources,
		// `kv.json` holds still, like every other file this push did not touch:
		// the bytes the folder already has, so nothing a person typed into it is
		// rewritten from the store. The base advances by exactly what the push
		// applied, which is what keeps the next plan from reporting an applied
		// setting as an edit nobody made, and it advances whether or not the
		// file is there: a folder somebody deleted `kv.json` from still has a
		// base, and starting it over would read the file coming back as an edit
		// to every setting in it.
		kv: { contents: kvContents, values: { ...base.kv, ...settings } },
		// Unchanged, because the folder is still current as of the last pull.
		// Only the files this push wrote moved, and each carries its own fresh
		// entry.
		pulledAt: base.pulledAt,
		ifMatch: held.etag,
		fetch: httpFetch,
	});
	return written.error === null
		? Ok(outcome)
		: CheckoutError.FolderStale({ ...outcome, cause: written.error });
}

/**
 * A planned change that could not be applied, as this module's own error.
 *
 * Reported rather than thrown, and the writes that landed still stand: what is
 * said is that not all of them did. Every case reaching here was checked
 * against a plan read a moment ago, so it means an invariant broke rather than
 * that a person did something.
 */
function unapplied(failure: {
	name: string;
	message: string;
}): Result<never, CheckoutError> {
	return CheckoutError.PushUnapplied({ reason: failure.message });
}

/** One file that became a row, and the id its file is renamed to. */
export type Admitted = {
	readonly path: string;
	readonly table: string;
	readonly rowId: string;
};

/** What a push did, in the terms a person is told it in. */
export type PushOutcome = {
	readonly rows: number;
	readonly values: number;
	/** Settings written to `kv.json`'s root, which is one write however many. */
	readonly settings: number;
	readonly bodies: number;
	/**
	 * Rows deleted because their file is gone (ADR-0338).
	 *
	 * Counted separately from `rows`, which is rows a value was written to,
	 * because this is the one number in here a person cannot undo: a file
	 * deletion does not pass through the application's trash.
	 */
	readonly deleted: number;
	readonly admitted: readonly Admitted[];
};

/**
 * The settings a push wrote, keyed by name.
 *
 * The base advances by this and nothing else, for the reason a kept row's
 * entry does not advance at all: a manifest that ran ahead of what landed
 * would read the difference as an edit at the next push.
 */
function appliedSettings(plan: PushPlan): JsonObject {
	const applied: JsonObject = {};
	for (const item of plan) {
		if (item.kind === 'setting') applied[item.name] = item.file;
	}
	return applied;
}

/**
 * The settings one `kv.json` says, or nothing when it is not a JSON object.
 *
 * The counterpart of `readRowFile`, and it refuses for the same reason: a file
 * this side cannot read is left exactly as the person wrote it, and the repair
 * is the file. Nested values are kept as they are, because nothing here
 * interprets a setting; `kv.get` is what decides whether one reads.
 */
function readSettings(contents: string): JsonObject | undefined {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		return undefined;
	}
	return isJsonObject(value) ? value : undefined;
}

/** The text under one file's fence, as the folder holds it right now. */
function bodyOf(held: FolderContents, path: string): string {
	return parseRowFile(held.files.get(path) ?? '')?.body ?? '';
}
