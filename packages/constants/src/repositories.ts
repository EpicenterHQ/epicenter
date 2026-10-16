/**
 * The names of hosted repositories (ADR-0546, ADR-0547), shared by the server
 * that resolves them, the `epicenter` CLI that builds remotes from them, and
 * the apps that propose them on Connect.
 *
 * A hosted folder's remote is `<git audience>/<namespace>/<name>.git`:
 *
 * - `<namespace>` is the owner's id: twelve characters of lowercase a-z and
 *   0-9, Epicenter's own, safe in a URL path segment;
 * - `<name>` is unique within its namespace and lowercase, so two names never
 *   collide on a case-insensitive disk. It holds `a-z`, `0-9`, `.`, `_`, and
 *   `-`, and starts with a letter or digit.
 *
 * Storage never sees either: it names each repository by its immutable id.
 */

/** A namespace id: twelve characters of lowercase a-z and 0-9. */
const NAMESPACE_ID = /^[a-z0-9]{12}$/;

/** The longest repository name the server accepts. */
export const MAX_REPOSITORY_NAME_LENGTH = 100;

const REPOSITORY_NAME = new RegExp(
	`^[a-z0-9][a-z0-9._-]{0,${MAX_REPOSITORY_NAME_LENGTH - 1}}$`,
);

export function isNamespaceId(value: string): boolean {
	return NAMESPACE_ID.test(value);
}

/**
 * Whether `value` is a repository name as stored. A name ending in `.git`
 * is refused, since the remote appends `.git` and Git strips one when it
 * names a clone's directory.
 */
export function isRepositoryName(value: string): boolean {
	return REPOSITORY_NAME.test(value) && !value.endsWith('.git');
}

/**
 * The repository name Connect proposes for a folder's directory name, or
 * `undefined` when nothing usable is left: letters are lowercased, every
 * character outside `a-z`, `0-9`, `.`, `_`, `-` becomes `-`, and leading
 * characters that are not a letter or digit are dropped. `so.epicenter.todos`
 * stays itself; `Demo Books` becomes `demo-books`.
 */
export function toRepositoryName(directory: string): string | undefined {
	let name = directory
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-')
		.replace(/^[^a-z0-9]+/, '')
		.slice(0, MAX_REPOSITORY_NAME_LENGTH);
	while (name.endsWith('.git')) name = name.slice(0, -'.git'.length);
	return isRepositoryName(name) ? name : undefined;
}

/** A repository named by its owner and its name. */
export type RepositoryPath = { namespace: string; name: string };

/** `<namespace>/<name>`, as `epicenter sync --to` and `epicenter clone` take it, or `undefined`. */
export function parseRepositoryPath(value: string): RepositoryPath | undefined {
	const [namespace, name, extra] = value.split('/');
	if (namespace === undefined || name === undefined || extra !== undefined)
		return undefined;
	return isNamespaceId(namespace) && isRepositoryName(name)
		? { namespace, name }
		: undefined;
}

/** The remote of `<namespace>/<name>` under a deployment's Git audience. */
export function repositoryUrl(
	gitAudience: string,
	{ namespace, name }: RepositoryPath,
): string {
	return `${gitAudience.replace(/\/+$/, '')}/${namespace}/${name}.git`;
}

/**
 * The repository a remote URL names under `gitAudience`, or `undefined` when
 * the URL is not one of that deployment's hosted repositories.
 */
export function parseRepositoryUrl(
	gitAudience: string,
	url: string,
): RepositoryPath | undefined {
	let target: URL;
	let audience: URL;
	try {
		target = new URL(url);
		audience = new URL(gitAudience);
	} catch {
		return undefined;
	}
	if (
		target.origin !== audience.origin ||
		target.username !== '' ||
		target.password !== '' ||
		target.search !== '' ||
		target.hash !== ''
	)
		return undefined;
	const prefix = audience.pathname.replace(/\/+$/, '');
	if (!target.pathname.startsWith(`${prefix}/`)) return undefined;
	const rest = target.pathname.slice(prefix.length + 1);
	if (!rest.endsWith('.git')) return undefined;
	return parseRepositoryPath(rest.slice(0, -'.git'.length));
}

/** One repository in `GET /api/repos`. */
export type ListedRepository = {
	/** The immutable id storage names it by. */
	id: string;
	name: string;
	/** Its remote, `<git audience>/<namespace>/<name>.git`. */
	url: string;
};

/** One namespace the caller belongs to in `GET /api/repos`, with its repositories. */
export type ListedNamespace = {
	id: string;
	title: string;
	/** Whether this is the caller's personal namespace, shown as "Personal". */
	personal: boolean;
	role: 'owner' | 'member';
	repositories: ListedRepository[];
};

/** The body of `GET /api/repos`: the personal namespace first, then each group by title. */
export type RepositoryListing = { namespaces: ListedNamespace[] };
