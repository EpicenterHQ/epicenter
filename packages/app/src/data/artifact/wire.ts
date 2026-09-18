/**
 * What a working copy looks like on the wire, and where it travels (ADR-0337).
 *
 * Pure, and here rather than in `checkout.ts` because of who needs it. The
 * desktop host writes these files, reads them back, and sweeps the ones a
 * checkout no longer names, and it does all of that without a definition, a
 * store, or a CRDT: it interprets nothing. `checkout.ts` holds the half that
 * does the interpreting, and it reaches `@y/y` to rewrite a live node, so a
 * host importing from there would load Yjs to concatenate strings.
 *
 * ## The wire
 *
 * NDJSON, one file per line, in both directions:
 *
 * ```txt
 * {"path":"notes/abc.md","contents":"---\ntitle: …\n---\n\n# …"}
 * {"path":"kv.json","contents":"{}"}
 * ```
 *
 * There is no manifest LINE, and the mirror's was not a simplification lost:
 * a pass was incremental, so it needed a line saying "that was all of it" and
 * a rule that nothing is removed until it arrives. A checkout is complete by
 * definition, so the set of paths sent IS the manifest, and the incomplete
 * case it guarded cannot be expressed.
 */

/** The host path both directions of a checkout travel through. */
export const CHECKOUT_PATH = '/api/checkout';

/** Where the manifest lives inside a working copy. */
export const MANIFEST_PATH = '.epicenter/manifest.json';

/**
 * Where the folder explains itself, to a person and to an agent alike.
 *
 * `AGENTS.md`, because that is the file an agent already looks for, and at the
 * folder root because that is where it is working. It is written by every pull
 * and replaced by every pull, and it says so on its first line: what lives here
 * is the store's, and a person keeping notes to themselves keeps them under
 * another name.
 */
export const AGENTS_PATH = 'AGENTS.md';

/** One file of a checkout, in either direction. */
export type CheckoutFile = { readonly path: string; readonly contents: string };

/** One line, encoded with its terminator, ready to concatenate. */
export function checkoutLine(file: CheckoutFile): string {
	return `${JSON.stringify(file)}\n`;
}

/**
 * Every file of a checkout, read back, skipping blanks and anything
 * unreadable.
 *
 * A line neither side can read is one file's worth of a checkout rather than
 * the checkout. Skipping it is safe in this direction and only this one:
 * `push` compares what came back against the manifest, so a file that went
 * missing on the wire reads as a deletion, which is why the reader that feeds
 * a push checks the count rather than trusting the stream.
 */
export function* parseCheckout(ndjson: string): Generator<CheckoutFile> {
	for (const line of ndjson.split('\n')) {
		if (line.trim() === '') continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof value !== 'object' || value === null) continue;
		const record = value as Record<string, unknown>;
		if (
			typeof record.path === 'string' &&
			typeof record.contents === 'string'
		) {
			yield { path: record.path, contents: record.contents };
		}
	}
}
