/**
 * `epicenter access` lists and changes who can reach the public address
 * (ADR-0871): people, each a passkey, and connectors, each a client a person
 * approved. It opens the same `access.local.sqlite` that `serve` holds open,
 * so it works while `serve` runs, and a change takes effect at once.
 *
 * ```txt
 * epicenter access                  people and connectors
 * epicenter access invite [<name>]  a link that registers one passkey, once, within 15 minutes
 * epicenter access revoke <name>    a connector: its consent and refresh tokens; a person: their passkey and sessions
 * ```
 */
import { join } from 'node:path';
import {
	type Connector,
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

/** One line per person and connector, for a person reading it. */
function render(entries: (Person | Connector)[]) {
	const people = entries.filter((entry) => entry.kind === 'person');
	const connectors = entries.filter((entry) => entry.kind === 'connector');
	const lines = [
		'People',
		...(people.length
			? people.map(
					(person) =>
						`  ${person.name}  approved ${when(person.approved)}, last signed in ${when(person.lastUsed)}`,
				)
			: ['  none yet: epicenter access invite']),
		'Connectors',
		...(connectors.length
			? connectors.map(
					(connector) =>
						`  ${connector.name} (${connector.host})  ${connector.scope.includes('write') ? 'reads and changes' : 'reads'}, approved ${when(connector.approved)}, last used ${when(connector.lastUsed)}`,
				)
			: ['  none yet']),
	];
	return lines.join('\n');
}

/** `epicenter access [invite [<name>] | revoke <name>]`. */
export async function accessCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const [verb, ...rest] = words;
	const fits =
		verb === undefined ||
		(verb === 'invite' && rest.length <= 1) ||
		(verb === 'revoke' && rest.length === 1);
	if (!fits || rest.some((word) => word === '' || word.startsWith('-')))
		return fail(
			usage(
				'epicenter access takes nothing, invite and maybe a name, or revoke and a name',
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
		const [target = ''] = rest;
		const matched = entries.filter(
			(entry) =>
				entry.id === target ||
				entry.name === target ||
				(entry.kind === 'connector' && entry.host === target),
		);
		if (matched.length === 0)
			return fail(
				CliError.Usage({
					message: `No person or connector is named ${target}`,
					next: 'epicenter access',
				}).error,
				json,
			);
		if (matched.length > 1)
			return fail(
				CliError.Refused({
					message: `${matched.length} match ${target}:\n${matched.map((entry) => `${entry.kind} ${entry.name}: ${entry.id}`).join('\n')}`,
					next: `epicenter access revoke ${matched[0]?.id}`,
				}).error,
				json,
			);
		const [entry] = matched as [Person | Connector];
		revokeAccess(server.db, entry);
		if (json) writeJson({ revoked: entry });
		else
			writeOut(
				entry.kind === 'connector'
					? `${entry.name} can no longer connect. A token it already holds ends within 15 minutes.`
					: `${entry.name} is signed out, and its passkey no longer signs in.`,
			);
		return 0;
	} finally {
		server.close();
	}
}
