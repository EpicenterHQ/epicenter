/**
 * The one grammar every Y.Doc guid obeys.
 *
 * A guid is the single string that simultaneously:
 *   1. names a Cloudflare Durable Object (the sync room),
 *   2. names an on-disk SQLite file (`<guid>.db`),
 *   3. keys the browser IndexedDB store,
 *   4. names the cross-tab BroadcastChannel (`yjs.<guid>`),
 *   5. is the HKDF domain-separation label for the workspace key.
 *
 * One string, five sinks. The charset below is the intersection that is safe
 * in all of them with zero transformation:
 *
 *   - lowercase `a-z` and digits `0-9`: the universally safe core. Lowercase
 *     is not cosmetic. Case-insensitive filesystems (default macOS, Windows)
 *     fold `Foo` and `foo` to the same file, so allowing uppercase would let
 *     two distinct guids collide on disk.
 *   - `-` joins words inside a segment (`local-books`). Safe in URLs and
 *     filenames; never percent-encoded.
 *   - `.` is RESERVED as the segment separator and therefore forbidden inside
 *     a segment. Reserving it to one job is what makes composed guids
 *     injective: `workspace.collection.row.field` cannot be re-parsed into any
 *     other tuple, because the three trailing segments contain no dots.
 *
 * Excluded on purpose: `:` (illegal in macOS/Windows filenames), `/`, `_`,
 * spaces, uppercase, leading/trailing/double hyphens, and the Windows
 * reserved node names (`con`, `nul`, ...), any of which would break one of
 * the five sinks.
 */
export const SAFE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const WINDOWS_RESERVED = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	'com1',
	'com2',
	'com3',
	'com4',
	'com5',
	'com6',
	'com7',
	'com8',
	'com9',
	'lpt1',
	'lpt2',
	'lpt3',
	'lpt4',
	'lpt5',
	'lpt6',
	'lpt7',
	'lpt8',
	'lpt9',
]);

/**
 * Assert that `value` is a single safe guid segment. Throws on anything that
 * would break a URL, a filename, or the injectivity of a composed guid. This
 * is the one chokepoint: every guid-minting path runs it, so a malformed id
 * fails at construction rather than as a 404 several layers downstream.
 *
 * @param value the candidate segment
 * @param label what it is, for the error message (e.g. `'workspace id'`)
 */
export function assertSafeSegment(value: string, label: string): void {
	if (!SAFE_SEGMENT.test(value) || WINDOWS_RESERVED.has(value)) {
		throw new Error(
			`Invalid ${label}: ${JSON.stringify(value)}. A guid segment must be lowercase a-z and 0-9 with single internal hyphens (matching ${SAFE_SEGMENT}), contain no dots, and not be a reserved node name.`,
		);
	}
}
