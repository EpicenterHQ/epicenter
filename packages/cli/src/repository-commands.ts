/**
 * `epicenter clone` and `epicenter repos`, and the hosted side of `epicenter
 * sync` (ADR-0546): a folder's remote is `<git origin>/<namespace>/<name>.git`
 * and the first push creates the repository.
 *
 * The credential is an access token for the deployment's Git audience, from
 * the grant the command runs under (`--desktop` selects the desktop app's).
 * For terminal Git it arrives through the credential helper that
 * `epicenter sync --to` and `epicenter clone` register in Git's global
 * configuration (`configureGitHelper`); for the `git` this binary runs for
 * the desktop it is handed over as a header, outside every argument, and only
 * to an `https` remote (`runHistory`'s `credential`).
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
	parseRepositoryPath,
	parseRepositoryUrl,
	type RepositoryListing,
	repositoryUrl,
} from '@epicenter/constants/repositories';
import type { UrlCredential } from '@epicenter/folder/bun';
import { resolveAppPaths } from './app-paths.ts';
import {
	type AuthContext,
	accessToken,
	authContext,
	configureGitHelper,
	type GrantKind,
} from './auth.ts';
import { gitCommand } from './install-command.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/** `git` with a clean environment but the person's own configuration, for the commands that touch only a path they name. */
async function git(
	args: readonly string[],
	env: Record<string, string> = {},
	cwd?: string,
) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** The `remote.origin.url` in the repository at `dir`, read from its own `.git/config` alone. */
export async function originUrl(dir: string): Promise<string | undefined> {
	const config = join(resolve(dir), '.git', 'config');
	if (!existsSync(config)) return undefined;
	const { code, stdout } = await git([
		'config',
		'--file',
		config,
		'--get',
		'remote.origin.url',
	]);
	return code === 0 ? stdout.trim() || undefined : undefined;
}

const grantOf = (desktop: boolean): GrantKind =>
	desktop ? 'desktop' : 'device';

/**
 * What a sync to `url` needs when `url` is one of this deployment's hosted
 * repositories, or `undefined` for any other remote. Nothing is created here:
 * the server answers a name nobody holds as an empty repository, so the
 * sync's fetch finds nothing, and its push creates the repository.
 */
export async function hostedRemote(
	ctx: AuthContext,
	grant: GrantKind,
	url: string | undefined,
): Promise<{ credential?: UrlCredential } | undefined> {
	if (
		url === undefined ||
		parseRepositoryUrl(ctx.deployment.audiences.git, url) === undefined
	)
		return undefined;
	const { data, error } = await accessToken(
		ctx,
		grant,
		ctx.deployment.audiences.git,
	);
	if (error !== null) throw new Error(error.message);
	return {
		credential: url.startsWith('https://')
			? { url, username: 'epicenter', password: data.token }
			: undefined,
	};
}

async function refusal(response: Response, url: string): Promise<string> {
	const body = (await response.json().catch(() => undefined)) as
		| { error_description?: string }
		| undefined;
	return `${url} answered ${response.status}${body?.error_description ? `: ${body.error_description}` : ''}`;
}

/**
 * Register this binary, through its per-user link, as Git's credential
 * helper for the deployment's Git origin, so a plain `git` in this folder
 * signs in too.
 */
export async function registerHelper(ctx: AuthContext) {
	const configured = await configureGitHelper(ctx, gitCommand());
	if (configured.error !== null)
		writeErr(`Plain git will not sign in to Epicenter: ${configured.error}`);
}

/** The remote `--to <namespace>/<name>` names on this deployment. */
export function remoteFor(ctx: AuthContext, to: string): string {
	const path = parseRepositoryPath(to);
	if (path === undefined)
		throw new Error(
			`'${to}' is not <namespace>/<name>: a namespace is 12 characters of a-z and 0-9, and a name is lowercase a-z, 0-9, '.', '_', and '-', starting with a letter or digit`,
		);
	return repositoryUrl(ctx.deployment.audiences.git, path);
}

/** `epicenter repos`: the caller's repositories by namespace. */
export async function repos(json: boolean, desktop: boolean) {
	const ctx = authContext();
	const { data, error } = await accessToken(
		ctx,
		grantOf(desktop),
		ctx.deployment.audiences.api,
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
	desktop: boolean,
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
	const hosted = parseRepositoryUrl(ctx.deployment.audiences.git, url);
	let env: Record<string, string> = {};
	if (hosted !== undefined) {
		await registerHelper(ctx);
		if (desktop) {
			// The desktop's grant is not the helper's: send its header for this run.
			const { data, error } = await accessToken(
				ctx,
				'desktop',
				ctx.deployment.audiences.git,
			);
			if (error !== null) return fail(error.message, json);
			env = {
				GIT_CONFIG_COUNT: '2',
				GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
				GIT_CONFIG_VALUE_0: `Authorization: Bearer ${data.token}`,
				GIT_CONFIG_KEY_1: 'credential.helper',
				GIT_CONFIG_VALUE_1: '',
			};
		}
	}
	const cloned = await git(
		['clone', '--no-recurse-submodules', '--template=', '--', url, dir],
		env,
	);
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
