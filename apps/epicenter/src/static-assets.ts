/**
 * Release-built SPA assets exposed by the Bun-owned Epicenter origin.
 *
 * The release layout is explicit: `home/index.html` plus one directory per
 * compiled application. The host loads the closed list supplied by the
 * composition root; it does not discover or admit application directories.
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import mime from 'mime';

export type StaticAsset = {
	file: ReturnType<typeof Bun.file>;
	contentType: string;
	isDocument: boolean;
};

/**
 * A built SPA the host serves below `/apps/<id>/`, and the document it boots
 * from.
 *
 * `page` is held in memory rather than streamed off disk because the host has
 * three things to do to it that a file cannot carry: gate it behind an
 * established browser session, stamp the auth bootstrap into it, and hash its
 * inline scripts into the one Content-Security-Policy this origin sends. That
 * stamp supplies the account identity used to reach the host's credential broker.
 * The app opens its own replica; the hash lets its boot script run.
 */
type ServedSpa = {
	id: string;
	title: string;
	page: string;
	resolve(pathname: string): Promise<StaticAsset | undefined>;
};

/**
 * One derived catalog member: enough to list it and serve its static root. Its
 * `id` comes from the database declaration (ADR-0210).
 */
/** One compiled application's release build. */
export type CompiledApplicationAssets = ServedSpa;

export type EpicenterStaticAssets = {
	homePage: string;
	/** Compiled applications, in the order the release declared them. */
	applications: CompiledApplicationAssets[];
};

/**
 * Load Home's document and the build of every compiled application this
 * release declares. Unlike catalog derivation, a declared application that did
 * not build is an error rather than an omission: the release promised it, Home
 * will list it, and a 404 behind a listed row is worse than refusing to start.
 */
export async function loadStaticAssets(
	appsDist: string,
	applications: readonly { id: string; title: string }[],
): Promise<EpicenterStaticAssets> {
	if (appsDist.trim() === '') {
		throw new Error(
			'EPICENTER_APPS_DIST must name the built applications directory.',
		);
	}

	const root = await requiredDirectory(appsDist, 'applications asset root');
	const homeIndex = await requiredFile(
		root,
		resolve(root, 'home', 'index.html'),
		'Home index',
	);

	return {
		homePage: await Bun.file(homeIndex).text(),
		applications: await Promise.all(
			applications.map(async ({ id, title }) => {
				const appRoot = await requiredContainedDirectory(
					root,
					resolve(root, id),
					`${title} asset root`,
				);
				const index = await requiredFile(
					appRoot,
					resolve(appRoot, 'index.html'),
					`${title} index`,
				);
				return {
					id,
					title,
					page: await Bun.file(index).text(),
					resolve: createContainedResolver({
						prefix: `/apps/${id}/`,
						root: appRoot,
						index,
					}),
				};
			}),
		),
	};
}

/**
 * The one contained static SPA resolver: existing files below `root` are
 * served directly, extensionless client-side routes fall back to the app
 * document, and missing generated assets stay honest 404s. Traversal,
 * separator smuggling, and symlink escape resolve to nothing. The app
 * document is flagged so the server can gate it behind an established
 * browser session and inject the identity snapshot.
 */
function createContainedResolver({
	prefix,
	root,
	index,
}: {
	prefix: string;
	root: string;
	index: string;
}): (pathname: string) => Promise<StaticAsset | undefined> {
	return async (pathname) => {
		const relativePath = containedRelativePath(pathname, prefix);
		if (relativePath === undefined) return undefined;

		const requested = relativePath === '' ? index : resolve(root, relativePath);
		const requestedFile = await containedFile(root, requested);
		if (requestedFile.kind === 'file') {
			return staticAsset(requestedFile.path, requestedFile.path === index);
		}
		if (requestedFile.kind === 'outside') return undefined;

		const lastSegment = relativePath.split('/').at(-1) ?? '';
		if (lastSegment.includes('.')) return undefined;
		return staticAsset(index, true);
	};
}

/**
 * Decode enough times to catch double-encoded separators and traversal while
 * retaining legitimate encoded filenames. URL query strings never enter this
 * function because callers pass `URL.pathname`.
 */
function containedRelativePath(
	pathname: string,
	prefix: string,
): string | undefined {
	let decoded = pathname;
	for (let depth = 0; depth < 8; depth += 1) {
		if (
			decoded.includes('\\') ||
			decoded.includes('\0') ||
			/%(?:00|2f|5c)/i.test(decoded)
		) {
			return undefined;
		}
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			return undefined;
		}
		if (next === decoded) break;
		decoded = next;
		if (depth === 7) return undefined;
	}

	if (!decoded.startsWith(prefix)) return undefined;
	const requested = decoded.slice(prefix.length);
	const segments = requested.split('/');
	if (
		requested.startsWith('/') ||
		segments.some(
			(segment, index) =>
				segment === '.' ||
				segment === '..' ||
				(segment === '' && index !== segments.length - 1),
		)
	) {
		return undefined;
	}
	return requested;
}

async function requiredDirectory(path: string, label: string): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch {
		throw new Error(`${label} is missing: ${path}`);
	}
	if (!(await stat(canonical)).isDirectory()) {
		throw new Error(`${label} is not a directory: ${path}`);
	}
	return canonical;
}

async function requiredContainedDirectory(
	root: string,
	path: string,
	label: string,
): Promise<string> {
	const canonical = await requiredDirectory(path, label);
	if (!isContained(root, canonical)) {
		throw new Error(`${label} escapes the applications asset root.`);
	}
	return canonical;
}

async function requiredFile(
	root: string,
	path: string,
	label: string,
): Promise<string> {
	const result = await containedFile(root, path);
	if (result.kind !== 'file') {
		throw new Error(`${label} is missing below ${root}.`);
	}
	return result.path;
}

async function containedFile(
	root: string,
	path: string,
): Promise<
	{ kind: 'file'; path: string } | { kind: 'missing' } | { kind: 'outside' }
> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch {
		return { kind: 'missing' };
	}
	if (!isContained(root, canonical)) return { kind: 'outside' };
	if (!(await stat(canonical)).isFile()) return { kind: 'missing' };
	return { kind: 'file', path: canonical };
}

function isContained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return (
		fromRoot !== '..' &&
		!fromRoot.startsWith(`..${sep}`) &&
		!isAbsolute(fromRoot)
	);
}

function staticAsset(path: string, isDocument = false): StaticAsset {
	return {
		file: Bun.file(path),
		contentType: mime.getType(path) ?? 'application/octet-stream',
		isDocument,
	};
}
