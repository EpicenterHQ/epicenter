/**
 * The store artifact: the legible folder a person keeps, in both
 * directions (ADR-0267, ADR-0268, ADR-0337).
 *
 * ```txt
 * .epicenter/manifest.json   what pull handed over, and from where
 * kv.json                    the kv root's stored values
 * <table>/<rowId>.md         one row per file: raw fields as frontmatter, and
 *                            the node through the table's codec as the body
 * ```
 *
 * `renderArtifact` yields every file a store renders to, one at a time.
 * `readArtifact` is the other direction, and it is whole-folder by nature
 * because a mint replaces a store rather than patching one (ADR-0293). The
 * per-row function underneath is not exported: nothing outside this package
 * ever wanted one row, and the caller that did was the mirror.
 *
 * Two pure inverse pairs sit underneath both: `rowPath`/`parseRowPath` for
 * where a row's file lives, and `rowFile`/`parseRowFile` for what is in it.
 * They are NOT re-exported here. They have their own entry point,
 * `@epicenter/app/artifact/format`, because reading a folder is not the same
 * job as holding a store and the host that writes these files has no business
 * loading a CRDT to parse a string. Offering them here too made that boundary
 * advisory: the heavy path stayed available, so nothing enforced the split.
 *
 * The verbs that move a whole folder are not here either. They are
 * `@epicenter/app/artifact/checkout`, because `pull` composes this layer with
 * an HTTP route the host serves, and a caller that wants to render a row
 * should not be handed one that talks to a filesystem it may not have.
 */
export {
	type ImportError,
	readArtifact,
} from './import.js';
export {
	type RenderableData,
	RenderError,
	type RenderedRow,
	renderArtifact,
} from './render.js';
