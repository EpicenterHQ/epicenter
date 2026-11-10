/**
 * `epicenter access` lists and changes who can reach the public address
 * (ADR-0871): people, each a passkey, and grants, each a connector one person
 * approved. It opens the same `access.local.sqlite` that `serve` holds open,
 * so it works while `serve` runs, and a change takes effect at once: the next
 * MCP call from a revoked grant is refused.
 *
 * ```txt
 * epicenter access                          people and grants
 * epicenter access invite [<name>]          a link that registers one passkey, once, within 15 minutes
 * epicenter access revoke <person>          their passkeys, sessions, and every grant they made
 * epicenter access revoke <connector>       every grant of that connector
 * epicenter access revoke <connector> <person>   that one grant
 * ```
 *
 * A connector is named by its client_id, its host, or the name its metadata
 * document gives it; a person by their name or id.
 */
import { join } from 'node:path';
import {
	type AccessTarget,
	type Grant,
	listAccess,
	openAuthorizationServer,
	type Person,
	revokeAccess,
} from './authorization-server.ts';
import { COMMANDS } from './commands.ts';
import { CliError } from './errors.ts';
import { localTime } from './history.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { epicenterRoot, ROOT_MARKER } from './root.ts';

const usage = (message: string) =>
	CliError.Usage({ message, next: COMMANDS.access }).error;

const when = (iso: string | undefined) =>
	iso === undefined ? 'never' : localTime(Date.parse(iso) / 1000);

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? '' : 's'}`;

/** One line per person, and per connector its grants, for a person reading it. */
function render(entries: (Person | Grant)[]) {
	const people = entries.filter((entry) => entry.kind === 'person');
	const grants = entries.filter((entry) => entry.kind === 'grant');
	const byConnector = Map.groupBy(grants, (grant) => grant.clientId);
	const lines = [
		'People',
		...(people.length
			? people.map(
					(person) =>
						`  ${person.name}  approved ${when(person.approved)}, last signed in ${when(person.lastUsed)}`,
				)
			: ['  none yet: epicenter access invite']),
		'Connectors',
		...(byConnector.size
			? [...byConnector.values()].flatMap(([first, ...rest]) => {
					if (!first) return [];
					return [
						`  ${first.host}  ${first.clientId}, which calls itself ${first.name}`,
						...[first, ...rest].map(
							(grant) =>
								`    approved by ${grant.person}: ${grant.scope.includes('write') ? 'reads and changes' : 'reads'}, approved ${when(grant.approved)}, last refresh ${when(grant.lastRefresh)}, ${plural(grant.families, 'connection')}`,
						),
					];
				})
			: ['  none yet']),
	];
	return lines.join('\n');
}

/** Whether `word` names this grant's connector. */
const namesConnector = (word: string, grant: Grant) =>
	word === grant.clientId || word === grant.host || word === grant.name;

/** Whether `word` names this person. */
const namesPerson = (word: string, person: Person) =>
	word === person.id || word === person.name;

/**
 * What `revoke` with these words ends, or why it ends nothing: one word names
 * a person or a connector, and two name one grant.
 */
function revokeTarget(
	entries: (Person | Grant)[],
	words: string[],
):
	| { target: AccessTarget; ended: (Person | Grant)[] }
	| { problem: string; ambiguous: boolean } {
	const people = entries.filter((entry) => entry.kind === 'person');
	const grants = entries.filter((entry) => entry.kind === 'grant');
	const [first = '', second] = words;
	if (second !== undefined) {
		const matched = grants.filter(
			(grant) =>
				namesConnector(first, grant) &&
				(second === grant.userId || second === grant.person),
		);
		if (matched.length === 1 && matched[0])
			return { target: matched[0], ended: matched };
		return matched.length
			? {
					problem: `${matched.length} grants match ${first} ${second}:\n${matched.map((grant) => `${grant.clientId} ${grant.userId}`).join('\n')}`,
					ambiguous: true,
				}
			: {
					problem: `No grant of ${first} approved by ${second}`,
					ambiguous: false,
				};
	}
	const named = people.filter((person) => namesPerson(first, person));
	const clients = [
		...new Set(
			grants
				.filter((grant) => namesConnector(first, grant))
				.map((grant) => grant.clientId),
		),
	];
	if (named.length + clients.length > 1)
		return {
			problem: `${named.length + clients.length} match ${first}:\n${[
				...named.map((person) => `person ${person.name}: ${person.id}`),
				...clients.map((clientId) => `connector ${clientId}`),
			].join('\n')}`,
			ambiguous: true,
		};
	const [person] = named;
	if (person)
		return {
			target: person,
			ended: [person, ...grants.filter((grant) => grant.userId === person.id)],
		};
	const [clientId] = clients;
	if (clientId)
		return {
			target: { kind: 'connector', clientId },
			ended: grants.filter((grant) => grant.clientId === clientId),
		};
	return {
		problem: `No person or connector is named ${first}`,
		ambiguous: false,
	};
}

/** `epicenter access [invite [<name>] | revoke <who> [<person>]]`. */
export async function accessCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const [verb, ...rest] = words;
	const fits =
		verb === undefined ||
		(verb === 'invite' && rest.length <= 1) ||
		(verb === 'revoke' && (rest.length === 1 || rest.length === 2));
	if (!fits || rest.some((word) => word === '' || word.startsWith('-')))
		return fail(
			usage(
				'epicenter access takes nothing, invite and maybe a name, or revoke and a person, a connector, or a connector and a person',
			),
			json,
		);
	const root = epicenterRoot();
	if (!root.public)
		return fail(
			CliError.Usage({
				message: `${join(root.folder, ROOT_MARKER)} has no public address, so no one signs in`,
				next: `add public: https://<host>:<port>/ and publicPort: <n> to ${join(root.folder, ROOT_MARKER)}`,
			}).error,
			json,
		);
	const server = await openAuthorizationServer(root.folder, root.public.url);
	try {
		const entries = listAccess(server.db);
		if (verb === undefined) {
			if (json) writeJson({ access: entries });
			else writeOut(render(entries));
			return 0;
		}
		if (verb === 'invite') {
			// Names stay distinct, so `revoke <name>` names one.
			const taken = new Set(entries.map((entry) => entry.name));
			let name = rest[0];
			if (name !== undefined && taken.has(name))
				return fail(
					CliError.Refused({
						message: `Something here is already named ${name}`,
						next: 'epicenter access',
					}).error,
					json,
				);
			for (let n = 1; name === undefined; n++)
				if (!taken.has(`device-${n}`)) name = `device-${n}`;
			const invite = await server.invite(name);
			if (json)
				writeJson({ name, url: invite.url, expiresAt: invite.expiresAt });
			else {
				writeOut(invite.url);
				writeErr(
					`Open this link on the device to add, within 15 minutes. It works once, and the passkey it makes is named ${name}.`,
				);
			}
			return 0;
		}
		const chosen = revokeTarget(entries, rest);
		if ('problem' in chosen)
			return fail(
				chosen.ambiguous
					? CliError.Refused({
							message: chosen.problem,
							next: 'epicenter access revoke <client_id or person id> [<person id>]',
						}).error
					: CliError.Usage({
							message: chosen.problem,
							next: 'epicenter access',
						}).error,
				json,
			);
		revokeAccess(server.db, chosen.target);
		if (json) writeJson({ revoked: chosen.ended });
		else {
			const person = chosen.ended.find((entry) => entry.kind === 'person');
			const grants = chosen.ended.filter((entry) => entry.kind === 'grant');
			writeOut(
				person
					? `${person.name} is signed out, their passkey no longer signs in, and ${plural(grants.length, 'connector grant')} they made ended.`
					: `${plural(grants.length, 'grant')} of ${rest[0]} ended. Its next call is refused, and it connects again only when someone approves it with a passkey.`,
			);
		}
		return 0;
	} finally {
		server.close();
	}
}
