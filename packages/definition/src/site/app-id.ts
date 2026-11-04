/**
 * The shared reverse-domain grammar for host application and store namespace IDs.
 *
 * Its own module, and not because `app-data.ts` grew too long. That file
 * resolves an OS application-data root, so it imports `node:os` and `node:path`
 * and cannot be bundled into a page. The grammar is a pure predicate over a
 * string, and both ends of the application storage protocol need it: the page
 * validates a name before sending it, and the host validates the same name on
 * arrival. Leaving it beside the path resolution meant one of them had to keep
 * a second copy, which is how a client starts refusing what a server accepts.
 *
 * **An app id is reverse domain, and that is enforced here rather than
 * observed.** Two or more lowercase dot-separated labels, which is the
 * namespace grammar ADR-0178 defines and ADR-0204 adopts as the app id.
 * Store definitions use the same grammar (ADR-0430), but a product may open
 * several store IDs. Existing host and persistence addresses keep their bytes;
 * sharing this predicate does not require their identifiers to be equal.
 *
 * This predicate used to admit a bare label, and the prose beside it explained
 * that an admitted folder names itself. That clause was withdrawn: ADR-0204
 * amended it so a candidate folder is named by the app's declared identifier,
 * and ADR-0227 then refused the installed-app plane outright, so no folder is
 * admitted by anything today. What the laxity actually described was one id
 * that had not taken ADR-0204's rename yet, which is a straggler rather than a
 * contract.
 *
 * The first and last character of every label must be alphanumeric, and that
 * is load-bearing rather than tidy: `appDataDir` joins an id onto the one data
 * root, so a grammar admitting `.` or `..` would hand a caller a path out of
 * the root, and one admitting a leading dot would let an app hide as a
 * dotfile. Requiring a dot does not replace those refusals, so they are still
 * spelled out and still tested.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const APP_ID_PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

export function isAppId(value: string): boolean {
	return APP_ID_PATTERN.test(value);
}
