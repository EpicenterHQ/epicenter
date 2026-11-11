/**
 * `epicenter connectors` lists and revokes the connectors the owner approved
 * (ADR-0871, ADR-0881). It opens the same `connectors.local.sqlite` that `serve`
 * holds open, so it works while `serve` runs, and a revoke takes effect at
 * once: the connector's next MCP call is refused.
 *
 * ```txt
 * epicenter connectors                      every connector, and what it may do
 * epicenter connectors revoke <connector>   end that connector's access
 * ```
 *
 * A connector is named by its client_id, its host, or the name its metadata
 * document gives it.
 */
import { join } from 'node:path';
import {
	type Grant,
	listGrants,
	openAuthorizationServer,
	revokeConnector,
} from './authorization-server.ts';
import { misuse, parseWords } from './commands.ts';
import { CliError } from './errors.ts';
import { plainTime } from './history.ts';
import { fail, writeJson, writeOut } from './output.ts';
import { epicenterRoot, MARKER } from './root.ts';

const when = (iso: string | undefined) =>
	iso === undefined ? 'never' : plainTime(Date.parse(iso) / 1000);

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? '' : 's'}`;

/** One block per connector, for a person reading it. */
function render(grants: Grant[]) {
	if (!grants.length) return 'No connectors yet.';
	return grants
		.map(
			(grant) =>
				`${grant.host}  ${grant.clientId}, which calls itself ${grant.name}\n  ${grant.scope.includes('write') ? 'reads and changes' : 'reads'}, approved ${when(grant.approved)}, last refresh ${when(grant.lastRefresh)}, ${plural(grant.families, 'connection')}`,
		)
		.join('\n');
}

/** `epicenter connectors [revoke <connector>]`. */
export async function connectorsCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, {}, [0, 2]);
	const [verb, connector, ...rest] = given?.positionals ?? [];
	const fits =
		given !== undefined &&
		rest.length === 0 &&
		(verb === undefined || (verb === 'revoke' && Boolean(connector)));
	if (!fits) return fail(misuse('connectors'), json);
	const root = epicenterRoot();
	const marker = join(root.folder, MARKER);
	if (!root.connectors)
		return fail(
			CliError.Usage({
				message: `${marker} has no connectors block, so no connector can reach it`,
				next: `add connectors: with url, port, and tailnet to ${marker}`,
			}).error,
			json,
		);
	const server = await openAuthorizationServer(root.folder, root.connectors);
	try {
		const grants = listGrants(server.db);
		if (verb === undefined) {
			if (json) writeJson({ connectors: grants });
			else writeOut(render(grants));
			return 0;
		}
		const named = [
			...new Set(
				grants
					.filter(
						(grant) =>
							connector === grant.clientId ||
							connector === grant.host ||
							connector === grant.name,
					)
					.map((grant) => grant.clientId),
			),
		];
		const [clientId] = named;
		if (named.length > 1)
			return fail(
				CliError.Refused({
					message: `${named.length} connectors match ${connector}:\n${named.join('\n')}`,
					next: 'epicenter connectors revoke <client_id>',
				}).error,
				json,
			);
		if (clientId === undefined)
			return fail(
				CliError.Usage({
					message: `No connector is named ${connector}`,
					next: 'epicenter connectors',
				}).error,
				json,
			);
		revokeConnector(server.db, clientId);
		if (json) writeJson({ revoked: clientId });
		else
			writeOut(
				`${connector} can no longer reach your apps. Its next call is refused, and it connects again only when you approve it on the tailnet.`,
			);
		return 0;
	} finally {
		server.close();
	}
}
