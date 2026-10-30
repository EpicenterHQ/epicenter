/**
 * What an Epicenter app is (ADR-0694): a manifest, and a module whose
 * `mount` shows the app over one open repository. Nothing here depends on a
 * framework: an app built with Svelte, React or plain DOM implements the
 * same `mount`.
 *
 * The shell owns the URL and history. An app's address is
 * `/<owner>/<repo>/<hostname>/<...path>` (ADR-0693); the app owns `path`,
 * everything after its hostname segment, and moves it with `navigate`. When
 * the URL changes under it (Back, Forward, a link), the shell calls
 * `setPath`, or mounts the app again when it has none.
 *
 *     export const manifest = defineManifest({
 *         name: 'Todos',
 *         hostname: 'todos.epicenter.so',
 *         collections: defineApp({ todos: { path: 'todos/{stem}.md', schema } }),
 *     });
 *
 *     export const mount: Mount<typeof manifest> = (element, { repo, path, navigate }) => {
 *         ...
 *         return { unmount() {}, setPath(next) {} };
 *     };
 */
import type { App, Definitions, Repository } from '@epicenter/repository';

/**
 * A hostname an app is served at the root of: two or more DNS labels, in
 * lowercase. One app per hostname; a build served elsewhere is another app.
 * No owner or repository name has a dot, so an address's third segment is
 * always an app.
 */
export const HOSTNAME =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Whether `value` is a hostname an app can be identified by. */
export const isHostname = (value: string) => HOSTNAME.test(value);

/** An app's manifest: the name a person knows it by, the hostname that identifies it, and the collections it reads (`defineApp`). */
export type AppManifest<TDefs extends Definitions = Definitions> = {
	readonly name: string;
	readonly hostname: string;
	readonly collections: App<TDefs>;
};

/** Any app's manifest, by the definitions it declares (an `App` is invariant in them, so `AppManifest` alone would admit none in particular). */
export type AnyManifest = {
	readonly collections: { readonly definitions: Definitions };
};

/** The collection definitions a manifest declares. */
export type DefinitionsOf<TManifest extends AnyManifest> =
	TManifest['collections']['definitions'];

/** Check a manifest once, where the app is defined: a bad hostname or an empty name is a mistake in the app's source. */
export function defineManifest<const TDefs extends Definitions>(
	manifest: AppManifest<TDefs>,
): AppManifest<TDefs> {
	if (manifest.name.trim() === '') throw new Error('An app needs a name');
	if (!isHostname(manifest.hostname))
		throw new Error(
			`'${manifest.hostname}' is not a hostname: two or more lowercase DNS labels`,
		);
	return manifest;
}

/**
 * Where an app is in its own routes: everything after its hostname segment,
 * starting with `/` (so `/` is its start), with the query. Segments stay as
 * the URL encodes them; the app decodes its own.
 */
export const isAppPath = (path: string) =>
	path.startsWith('/') && !path.startsWith('//');

/**
 * The file an app path names, for an app whose routes are file paths
 * (Files, Honeycrisp): `/notes/pasta.md` names `notes/pasta.md`, each
 * segment decoded; the query is not part of it. Undefined for `/`, a
 * folder (a trailing `/`), or a segment that does not decode.
 */
export function fileOfPath(path: string): string | undefined {
	const [pathname = ''] = path.split(/[?#]/, 1);
	if (!isAppPath(pathname) || pathname.endsWith('/')) return undefined;
	try {
		return pathname.slice(1).split('/').map(decodeURIComponent).join('/');
	} catch {
		return undefined;
	}
}

/** The app path that names `file`, each segment encoded: the inverse of `fileOfPath`. */
export const pathOfFile = (file: string) =>
	`/${file.split('/').map(encodeURIComponent).join('/')}`;

/** Ask the shell to move the app to `path`: a new history entry, or `replace` the current one. Resolves once the URL shows it. */
export type Navigate = (
	path: string,
	options?: { replace?: boolean },
) => Promise<void>;

/** What the shell gives an app it mounts. */
export type MountOptions<TDefs extends Definitions = Definitions> = {
	/** The open repository, as the app's collections read it, with the plain file API (`repo.files`). */
	repo: Repository<TDefs>;
	/** Where the app starts (`isAppPath`). */
	path: string;
	navigate: Navigate;
};

/** A mounted app. `setPath` follows a URL that changed under it; without it, the shell mounts the app again. */
export type Mounted = {
	unmount(): void | Promise<void>;
	setPath?(path: string): void;
};

/** Show an app in `element`, over one open repository, until `unmount`. */
export type Mount<TManifest extends AnyManifest = AppManifest> = (
	element: HTMLElement,
	options: MountOptions<DefinitionsOf<TManifest>>,
) => Mounted;

/** The module an app's bundle exports. */
export type AppModule<TManifest extends AnyManifest = AppManifest> = {
	mount: Mount<TManifest>;
};
