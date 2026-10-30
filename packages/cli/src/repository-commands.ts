/**
 * `epicenter repos`, and the hosted side of `epicenter clone` and `sync`
 * (ADR-0546): a folder's remote is `<git origin>/<namespace>/<name>.git`,
 * and the first push creates the repository.
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
	parseRepositoryUrl,
	type RepositoryListing,
} from '@epicenter/constants/repositories';
import type { GitCredentials } from '@epicenter/folder/bun';
import {
	type AuthContext,
	accessToken,
	authContext,
	type GrantKind,
} from './auth.ts';
import { EXIT, fail, writeJson, writeOut } from './output.ts';

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
