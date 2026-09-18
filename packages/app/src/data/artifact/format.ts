/**
 * The working copy's format, as pure functions (ADR-0268, ADR-0337).
 *
 * Two inverse pairs for one row's file: `rowPath`/`parseRowPath` for where it
 * lives, and `rowFile`/`parseRowFile` for what is in it. Plus the NDJSON a
 * whole checkout travels as, and the three paths that are not rows. No store,
 * no CRDT, no definition, no I/O.
 *
 * Its own entry point because of who needs it. Reading a folder is not the same
 * job as holding a store: the desktop host writes these files, reads them back,
 * and sweeps the ones a checkout no longer names, and it has no business loading
 * a CRDT to do any of it. Reaching through `@epicenter/app/artifact` would drag
 * `@y/y` in behind `readArtifact`, and reaching through
 * `@epicenter/app/artifact/checkout` would drag it in behind `rewrite`; either
 * is how a boundary becomes incidental rather than structural.
 *
 * So the NDJSON the host speaks is here too, from `wire.js`. "Two inverse pairs
 * and nothing else" was the rule until the host needed a third thing, and the
 * rule that survives is the one that was always the point: everything a host
 * reads or writes without a definition.
 */
export {
	frontmatter,
	type ParsedRowFile,
	parseRowFile,
	rowFile,
} from './frontmatter.js';
export { parseRowPath, ROW_FILE_EXTENSION, rowPath } from './layout.js';
export {
	AGENTS_PATH,
	CHECKOUT_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
} from './wire.js';
