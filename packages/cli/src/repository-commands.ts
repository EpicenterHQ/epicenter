/**
 * `epicenter clone` and `epicenter repos`, and the hosted side of `epicenter
 * sync` (ADR-0546): a folder's remote is `<git origin>/<namespace>/<name>.git`
 * and the first push creates the repository.
 *
 * The credential is an access token for the deployment's Git audience, from
 * the grant the command runs under (`--desktop` selects the desktop app's).
 * Every `git` this binary runs itself, a clone or a sync's fetch and push,
 * gets it as a header, outside every argument, and only for an `https`
 * remote (`hostedCredentials`), so a refresh always runs in this process and
 * never in a `git` it started (ADR-0565). A person's own `git` gets it from
 * the credential helper, which only `epicenter auth login` writes.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
	parseRepositoryPath,
	parseRepositoryUrl,
	type RepositoryListing,
	repositoryUrl,
} from '@epicenter/constants/repositories';
import {
	basicAuthorization,
	type GitCredentials,
	runGit,
} from '@epicenter/folder/bun';
import { resolveAppPaths } from './app-paths.ts';
import {
	type AuthContext,
	accessToken,
	authContext,
	type GrantKind,
} from './auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/**
 * The credential for a remote of this deployment's hosted Git, asked for by
 * URL as each transfer starts: the grant's access token for the Git
 * audience, sent only to an `https` remote. Any other remote gets none, so
 * Git uses the person's own sign-in. Nothing is created here: the server
 * answers a name nobody holds as an empty repository, so the sync's fetch
 * finds nothing, and its push creates the repository.
 */
export function hostedCredentials(
	ctx: AuthContext,
	grant: GrantKind,
): GitCredentials {
	return async (url) => {
		if (
			!url.startsWith('https://') ||
			parseRepositoryUrl(ctx.deployment.audiences.git, url) === undefined
		)
			return undefined;
		const { data, error } = await accessToken(
			ctx,
			grant,
			ctx.deployment.audiences.git,
		);
		if (error !== null) throw new Error(error.message);
		return { username: 'epicenter', password: data.token };
	};
}

async function refusal(response: Response, url: string): Promise<string> {
	const body = (await response.json().catch(() => undefined)) as
		| { error_description?: string }
		| undefined;
	return `${url} answered ${response.status}${body?.error_description ? `: ${body.error_description}` : ''}`;
}

/**
 * The remote `--to` names: `<namespace>/<name>` on this deployment, or any
 * other remote by its URL.
 */
export function remoteFor(ctx: AuthContext, to: string): string {
	const path = parseRepositoryPath(to);
	if (path !== undefined)
		return repositoryUrl(ctx.deployment.audiences.git, path);
	if (URL.canParse(to)) return to;
	throw new Error(
		`'${to}' is neither a URL nor <namespace>/<name>: a namespace is 12 characters of a-z and 0-9, and a name is lowercase a-z, 0-9, '.', '_', and '-', starting with a letter or digit`,
	);
}

/** `epicenter repos`: the caller's repositories by namespace. */
export async function repos(json: boolean, grant: GrantKind) {
	const ctx = authContext();
	// The listing is folder metadata, served at the Git audience (ADR-0549).
	const { data, error } = await accessToken(
		ctx,
		grant,
		ctx.deployment.audiences.git,
	);
	if (error !== null) return fail(error.message, json);
	let response: Response;
	try {
		response = await ctx.fetch(`${ctx.deployment.origin}/api/repos`, {
			headers: { authorization: `Bearer ${data.token}` },
		});
	} catch (cause) {
		return fail(
			`Could not reach ${ctx.deployment.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
			json,
		);
	}
	if (!response.ok)
		return fail(
			await refusal(response, `${ctx.deployment.origin}/api/repos`),
			json,
		);
	const listing = (await response.json()) as RepositoryListing;
	if (json) {
		writeJson(listing);
		return EXIT.ok;
	}
	const lines: string[] = [];
	for (const namespace of listing.namespaces) {
		lines.push(
			`${namespace.personal ? 'Personal' : namespace.title} (${namespace.id})`,
		);
		if (namespace.repositories.length === 0) lines.push('  no repositories');
		for (const repository of namespace.repositories)
			lines.push(`  ${namespace.id}/${repository.name}`);
	}
	writeOut(lines.length === 0 ? 'No namespaces.' : lines.join('\n'));
	return EXIT.ok;
}

/**
 * `epicenter clone <namespace>/<name> | <url> [<dir>]`: clone a hosted
 * repository into `<dir>`, by default `~/Epicenter/<name>` where its app looks
 * for it, then make the clone merge by file kind. Another URL is cloned as
 * given, with the person's own Git credentials.
 */
export async function clone(
	source: string,
	target: string | undefined,
	json: boolean,
	grant: GrantKind,
) {
	const ctx = authContext();
	let url: string;
	let name: string;
	const path = parseRepositoryPath(source);
	if (path !== undefined) {
		url = repositoryUrl(ctx.deployment.audiences.git, path);
		name = path.name;
	} else {
		url = source;
		const hosted = parseRepositoryUrl(ctx.deployment.audiences.git, url);
		name = hosted?.name ?? basename(new URL(url).pathname, '.git');
	}
	if (name === '') return fail(`'${source}' names no repository`, json);
	const dir = resolve(target ?? join(dirname(resolveAppPaths().appsDir), name));
	if (existsSync(dir) && readdirSync(dir).length > 0)
		return fail(`${dir} already exists and is not empty`, json);
	let cloned: Awaited<ReturnType<typeof runGit>>;
	try {
		const credential = await hostedCredentials(ctx, grant)(
			url,
			AbortSignal.timeout(60_000),
		);
		cloned = await runGit(
			['clone', '--no-recurse-submodules', '--template=', '--', url, dir],
			{
				allowFailure: true,
				credential:
					credential === undefined
						? undefined
						: { url, authorization: basicAuthorization(credential) },
			},
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), json);
	}
	if (cloned.code !== 0)
		return fail(
			cloned.stderr.trim() || `git clone exited ${cloned.code}`,
			json,
		);
	try {
		const { configureMergeDriver } = await import('./merge-driver.ts');
		await configureMergeDriver(dir);
	} catch (error) {
		writeErr(
			`git merge will merge this folder's files as text: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (json) writeJson({ cloned: { url, dir } });
	else writeOut(`Cloned ${url} into ${dir}`);
	return EXIT.ok;
}
