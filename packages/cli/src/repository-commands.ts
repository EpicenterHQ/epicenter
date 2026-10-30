/**
 * `epicenter repos`, `share`, `unshare`, and the hosted side of
 * `epicenter clone` and `sync` (ADR-0546): a folder's remote is
 * `<git origin>/<namespace>/<name>.git`, and the first push creates the
 * repository. Its owner shares it with another person by their handle (the
 * id of their personal namespace, which `epicenter repos` prints), who then
 * clones `<owner handle>/<name>`.
 *
 * The credential is an access token for the deployment's Git audience, from
 * the grant the command runs under (`--desktop` selects the desktop app's).
 * Every `git` this binary runs itself, a clone or a sync's fetch and push,
 * gets it as a header, outside every argument, and only for an `https`
 * remote (`hostedCredentials`), so a refresh always runs in this process and
 * never in a `git` it started (ADR-0565). A person's own `git` gets it from
 * the credential helper, which `epicenter auth login` writes globally and
 * `epicenter init` per clone.
 */

import {
	type GrantLevel,
	isRepositoryName,
	parseRepositoryPath,
	parseRepositoryUrl,
	type RepositoryGrant,
	type RepositoryGrantRevoked,
	type RepositoryGrants,
	type RepositoryListing,
	type RepositoryPath,
	repositoryGrantsUrl,
} from '@epicenter/constants/repositories';
import type { GitCredentials } from '@epicenter/folder/bun';
import {
	type AuthContext,
	accessToken,
	authContext,
	type GrantKind,
} from './auth.ts';
import { EXIT, fail, writeJson, writeOut } from './output.ts';
import { config } from './sync/git.ts';

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
 * One request to the deployment with the grant's Git-audience token, which
 * the repository listing and the sharing routes take (ADR-0549): the JSON
 * answer, or why there is none, ready to print.
 */
async function request<T>(
	ctx: AuthContext,
	grant: GrantKind,
	url: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ data: T; error: null } | { data: null; error: string }> {
	const { data, error } = await accessToken(
		ctx,
		grant,
		ctx.deployment.audiences.git,
	);
	if (error !== null) return { data: null, error: error.message };
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			method: init.method ?? 'GET',
			headers: {
				authorization: `Bearer ${data.token}`,
				...(init.body === undefined
					? {}
					: { 'content-type': 'application/json' }),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
	} catch (cause) {
		return {
			data: null,
			error: `Could not reach ${ctx.deployment.origin}: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
	if (!response.ok) return { data: null, error: await refusal(response, url) };
	return { data: (await response.json()) as T, error: null };
}

/** `epicenter repos`: the caller's repositories by namespace. */
export async function repos(json: boolean, grant: GrantKind) {
	const ctx = authContext();
	// The listing is folder metadata, served at the Git audience (ADR-0549).
	const { data: listing, error } = await request<RepositoryListing>(
		ctx,
		grant,
		`${ctx.deployment.origin}/api/repos`,
	);
	if (error !== null) return fail(error, json);
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
 * The hosted repository `target` names: `<owner>/<name>`, `~/<name>` (the
 * caller's own), or a folder whose `origin` is one of this deployment's.
 */
async function repositoryOf(
	ctx: AuthContext,
	target: string,
): Promise<RepositoryPath | undefined> {
	const own = /^~\/(.+)$/.exec(target)?.[1];
	if (own !== undefined)
		return isRepositoryName(own) ? { namespace: '~', name: own } : undefined;
	const named = parseRepositoryPath(target);
	if (named !== undefined) return named;
	const url = await config(target, 'remote.origin.url').catch(() => null);
	return url === null
		? undefined
		: parseRepositoryUrl(ctx.deployment.audiences.git, url);
}

/**
 * `epicenter share <repository> [<handle> --read|--write]`: let the person
 * whose handle is `<handle>` read, or also write, one of the caller's
 * repositories, replacing any grant they had; without `<handle>`, list who
 * it is shared with.
 */
export async function share(
	target: string,
	person: string | undefined,
	options: Record<string, string | true>,
	json: boolean,
	grant: GrantKind,
) {
	const ctx = authContext();
	const repository = await repositoryOf(ctx, target);
	if (repository === undefined)
		return fail(
			`'${target}' is neither <owner>/<name>, ~/<name>, nor a folder cloned from this deployment`,
			json,
		);
	const shown = `${repository.namespace}/${repository.name}`;
	if (person === undefined) {
		if (options.read !== undefined || options.write !== undefined)
			return fail('--read and --write need a <handle> to share with', json);
		const { data, error } = await request<RepositoryGrants>(
			ctx,
			grant,
			repositoryGrantsUrl(ctx.deployment.origin, repository),
		);
		if (error !== null) return fail(error, json);
		if (json) writeJson(data);
		else
			writeOut(
				data.grants.length === 0
					? `${shown} is not shared with anyone.`
					: data.grants
							.map(({ person, level }) => `${person}\t${level}`)
							.join('\n'),
			);
		return EXIT.ok;
	}
	if ((options.read === undefined) === (options.write === undefined))
		return fail('Pass exactly one of --read or --write.', json);
	const level: GrantLevel = options.write === undefined ? 'read' : 'write';
	const { data, error } = await request<RepositoryGrant>(
		ctx,
		grant,
		repositoryGrantsUrl(ctx.deployment.origin, repository, person),
		{ method: 'PUT', body: { level } },
	);
	if (error !== null) return fail(error, json);
	if (json) writeJson(data);
	else
		writeOut(
			`${person} may now ${level === 'write' ? 'read and write' : 'read'} ${shown}.`,
		);
	return EXIT.ok;
}

/** `epicenter unshare <repository> <handle>`: revoke that person's grant. */
export async function unshare(
	target: string,
	person: string,
	json: boolean,
	grant: GrantKind,
) {
	const ctx = authContext();
	const repository = await repositoryOf(ctx, target);
	if (repository === undefined)
		return fail(
			`'${target}' is neither <owner>/<name>, ~/<name>, nor a folder cloned from this deployment`,
			json,
		);
	const { data, error } = await request<RepositoryGrantRevoked>(
		ctx,
		grant,
		repositoryGrantsUrl(ctx.deployment.origin, repository, person),
		{ method: 'DELETE' },
	);
	if (error !== null) return fail(error, json);
	if (json) writeJson(data);
	else
		writeOut(
			data.revoked
				? `${person} no longer has access to ${repository.namespace}/${repository.name}.`
				: `${repository.namespace}/${repository.name} was not shared with ${person}.`,
		);
	return EXIT.ok;
}
