/**
 * This machine's AI connections (ADR-0587): `connections.json` in app data,
 * which only this CLI writes, and one keychain entry per `openai-compatible`
 * connection holding its endpoint and key (`@epicenter/ai/send`).
 *
 * ```txt
 * <dataDir>/connections.json
 *   {
 *     "connections": { "<id>": { "kind", "title", "model" } },
 *     "apps": { "<app id>": { "<operation>": "<connection id>" } }
 *   }
 * keychain so.epicenter.connections, <id> -> { "endpoint", "key" }
 * ```
 *
 * The endpoint stays with the key, so editing the file cannot send a key to
 * another server: `send` sends only while the keychain entry holds the
 * endpoint a request was prepared for, and always to the entry's own.
 * Setting a connection writes its entry, then its key; removing one deletes
 * its key, then its entry. A crash between the two leaves an entry the
 * listing shows as "key missing", never a key no entry names. Every write
 * holds `<cacheDir>/connections.lock`, so two runs never interleave.
 *
 * Which connection an app uses for an operation is kept under the app's id
 * in `apps`, on this machine only. A choice that synced could send a
 * person's audio to another provider on a machine where the same id names a
 * different endpoint or account.
 *
 * A file that does not read is refused, named, and never overwritten: a
 * person or agent repairs it, or deletes it and sets the connections up
 * again.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	CONNECTION_KINDS,
	type ConnectionKind,
	canonicalEndpoint,
	isConnectionId,
	type KeyState,
	keyState,
	removeKey,
	type SecretStore,
	SendError,
	saveKey,
} from '@epicenter/ai/send';
import { holdingFileLock } from '@epicenter/folder/bun';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppPaths } from './app-paths.ts';
import { appIdProblem } from './installed-apps.ts';

/** One connection's entry: what may be read without a key. */
export type ConnectionEntry = {
	kind: ConnectionKind;
	title: string;
	/** The model a request names when its caller names none. Empty for a local connection, which uses the active local model. */
	model: string;
};

/** `connections.json` as it reads. */
export type ConnectionsFile = {
	connections: Record<string, ConnectionEntry>;
	/** Each app's choice of connection by operation, such as `{ "transcription": "groq" }`. */
	apps: Record<string, Record<string, string>>;
};

/**
 * What the listing says of an `openai-compatible` connection's keychain
 * entry, never the key: missing, saved for an endpoint, or unreadable, with
 * why.
 */
export type ListedKey = KeyState | { state: 'unreadable'; message: string };

/** One connection as `auth key list` prints it. `key` is null for a kind that has none. */
export type ListedConnection = ConnectionEntry & {
	id: string;
	key: ListedKey | null;
};

/** What `epicenter auth key list --json` prints. */
export type ConnectionListing = {
	connections: ListedConnection[];
	apps: ConnectionsFile['apps'];
};

export const ConnectionsError = defineErrors({
	/** `connections.json` is there and does not read as one. Nothing was written. */
	Unreadable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} does not read: ${reason}. Repair it, or delete it and set the connections up again.`,
		path,
		reason,
	}),
	/** The command's input cannot be used. Nothing was written. */
	InvalidInput: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	/** `connections.json` could not be written. */
	WriteFailed: ({ path, reason }: { path: string; reason: string }) => ({
		message: `${path} could not be written: ${reason}`,
		path,
		reason,
	}),
});
export type ConnectionsError = InferErrors<typeof ConnectionsError>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where the file and its lock are. */
function locations(paths: Pick<AppPaths, 'dataDir' | 'cacheDir'>) {
	return {
		file: join(paths.dataDir, 'connections.json'),
		lock: join(paths.cacheDir, 'connections.lock'),
	};
}

/** Why `value` is not a `connections.json`, or what it holds. */
function parseFile(value: unknown): Result<ConnectionsFile, string> {
	if (!isRecord(value)) return Err('it is not a JSON object');
	for (const key of Object.keys(value))
		if (key !== 'connections' && key !== 'apps')
			return Err(`it has '${key}', which is neither "connections" nor "apps"`);
	const { connections = {}, apps = {} } = value;
	if (!isRecord(connections)) return Err('"connections" is not an object');
	if (!isRecord(apps)) return Err('"apps" is not an object');
	const file: ConnectionsFile = { connections: {}, apps: {} };
	for (const [id, entry] of Object.entries(connections)) {
		if (!isConnectionId(id)) return Err(`'${id}' is not a connection id`);
		if (!isRecord(entry)) return Err(`'${id}' is not an object`);
		const { kind, title, model, ...rest } = entry;
		const extra = Object.keys(rest)[0];
		if (extra !== undefined)
			return Err(
				`'${id}' has '${extra}'; an entry holds kind, title, and model`,
			);
		if (!CONNECTION_KINDS.includes(kind as ConnectionKind))
			return Err(`'${id}' has the kind '${String(kind)}'`);
		if (typeof title !== 'string' || typeof model !== 'string')
			return Err(`'${id}' needs a title and a model, each a string`);
		file.connections[id] = { kind: kind as ConnectionKind, title, model };
	}
	for (const [app, uses] of Object.entries(apps)) {
		if (appIdProblem(app) !== undefined)
			return Err(`'${app}' in "apps" is not an app id`);
		if (!isRecord(uses)) return Err(`'${app}' in "apps" is not an object`);
		const chosen: Record<string, string> = {};
		for (const [operation, connection] of Object.entries(uses)) {
			if (!isConnectionId(operation) || !isConnectionId(connection))
				return Err(
					`'${app}' in "apps" maps '${operation}' to something that is not a connection id`,
				);
			chosen[operation] = connection;
		}
		file.apps[app] = chosen;
	}
	return Ok(file);
}

/** The file at `path`, empty when there is none. */
async function readConnectionsFile(
	path: string,
): Promise<Result<ConnectionsFile, ConnectionsError>> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (cause) {
		if ((cause as { code?: string }).code === 'ENOENT')
			return Ok({ connections: {}, apps: {} });
		return ConnectionsError.Unreadable({ path, reason: describe(cause) });
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return ConnectionsError.Unreadable({ path, reason: 'it is not JSON' });
	}
	const { data, error } = parseFile(value);
	if (error !== null)
		return ConnectionsError.Unreadable({ path, reason: error });
	return Ok(data);
}

/** Replace the file at `path` with `file` in one rename, so a reader never sees half of it. */
async function writeConnectionsFile(
	path: string,
	file: ConnectionsFile,
): Promise<Result<undefined, ConnectionsError>> {
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, `${JSON.stringify(file, null, '\t')}\n`);
		await rename(temporary, path);
		return Ok(undefined);
	} catch (cause) {
		await rm(temporary, { force: true });
		return ConnectionsError.WriteFailed({ path, reason: describe(cause) });
	}
}

/** Run `work` holding the connections lock. */
function exclusively<T>(lock: string, work: () => Promise<T>) {
	return holdingFileLock(
		lock,
		{
			waitMs: 10_000,
			held: `another epicenter process has held ${lock} for over 10 seconds`,
		},
		work,
	);
}

/** What the keychain holds for `id`, as the listing says it. */
async function listedKey(
	secrets: SecretStore,
	id: string,
	kind: ConnectionKind,
): Promise<ListedKey | null> {
	if (kind !== 'openai-compatible') return null;
	const { data, error } = await keyState(secrets, id);
	if (error !== null) return { state: 'unreadable', message: error.message };
	return data;
}

/**
 * Every connection on this machine, each with what the keychain holds for
 * it but never the key, and each app's choices. A keychain entry that cannot
 * be read lists as `unreadable` rather than failing the listing.
 */
export async function listConnections(
	paths: Pick<AppPaths, 'dataDir' | 'cacheDir'>,
	secrets: SecretStore,
): Promise<Result<ConnectionListing, ConnectionsError>> {
	const { data: file, error } = await readConnectionsFile(
		locations(paths).file,
	);
	if (error !== null) return Err(error);
	const connections = await Promise.all(
		Object.entries(file.connections)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(async ([id, entry]) => ({
				id,
				...entry,
				key: await listedKey(secrets, id, entry.kind),
			})),
	);
	return Ok({ connections, apps: file.apps });
}

/** What `auth key set` reads on stdin: every member optional. */
type ConnectionChange = Partial<ConnectionEntry> & {
	endpoint?: string;
	key?: string;
};

const CHANGE_MEMBERS = ['kind', 'title', 'model', 'endpoint', 'key'];

function readChange(
	input: unknown,
): Result<ConnectionChange, ConnectionsError> {
	const usage =
		'stdin must be one JSON object with any of "kind", "title", "model", "endpoint", and "key"';
	if (!isRecord(input)) return ConnectionsError.InvalidInput({ reason: usage });
	for (const [name, value] of Object.entries(input)) {
		if (!CHANGE_MEMBERS.includes(name))
			return ConnectionsError.InvalidInput({
				reason: `${usage}, not "${name}"`,
			});
		if (typeof value !== 'string')
			return ConnectionsError.InvalidInput({
				reason: `"${name}" must be a string`,
			});
	}
	const { kind } = input;
	if (kind !== undefined && !CONNECTION_KINDS.includes(kind as ConnectionKind))
		return ConnectionsError.InvalidInput({
			reason: `"kind" is one of ${CONNECTION_KINDS.join(', ')}, not '${String(kind)}'`,
		});
	return Ok(input as ConnectionChange);
}

/**
 * Add or change connection `id` and, with an endpoint, save its endpoint
 * and key: the entry first, then the keychain. A new connection needs a
 * kind, and an existing one keeps its kind. Only an `openai-compatible`
 * connection has an endpoint and key, and a key is saved with its endpoint;
 * an empty key confirms a keyless endpoint.
 */
export async function setConnection(
	paths: Pick<AppPaths, 'dataDir' | 'cacheDir'>,
	secrets: SecretStore,
	id: string,
	input: unknown,
): Promise<Result<ListedConnection, ConnectionsError | SendError>> {
	if (!isConnectionId(id))
		return ConnectionsError.InvalidInput({
			reason: `'${id}' is not a connection id: use letters, digits, '.', '_', and '-'`,
		});
	const { data: change, error: changeError } = readChange(input);
	if (changeError !== null) return Err(changeError);
	const { file: path, lock } = locations(paths);
	return exclusively(lock, async () => {
		const { data: file, error: readError } = await readConnectionsFile(path);
		if (readError !== null) return Err(readError);
		const current = file.connections[id];
		const kind = current?.kind ?? change.kind;
		if (kind === undefined)
			return ConnectionsError.InvalidInput({
				reason: `There is no connection '${id}' on this computer. Give its "kind" to add it.`,
			});
		if (change.kind !== undefined && change.kind !== kind)
			return ConnectionsError.InvalidInput({
				reason: `'${id}' is a ${kind} connection. Remove it and add it again to change its kind.`,
			});
		const entry: ConnectionEntry = {
			kind,
			title: (change.title ?? current?.title ?? '').trim(),
			model: (change.model ?? current?.model ?? '').trim(),
		};
		const savesKey = change.endpoint !== undefined || change.key !== undefined;
		if (savesKey && entry.kind !== 'openai-compatible')
			return ConnectionsError.InvalidInput({
				reason: `A ${entry.kind} connection has no endpoint or key.`,
			});
		if (savesKey && change.endpoint === undefined)
			return ConnectionsError.InvalidInput({
				reason:
					'A key is saved with the endpoint it is for: give "endpoint" too.',
			});
		// Checked before anything is written, so a bad endpoint writes nothing.
		if (change.endpoint !== undefined) {
			const { error } = canonicalEndpoint(change.endpoint);
			if (error !== null) return SendError.InvalidRequest({ reason: error });
		}
		const { error: writeError } = await writeConnectionsFile(path, {
			...file,
			connections: { ...file.connections, [id]: entry },
		});
		if (writeError !== null) return Err(writeError);
		if (change.endpoint !== undefined) {
			const { error } = await saveKey(secrets, id, {
				endpoint: change.endpoint,
				key: change.key,
			});
			if (error !== null) return Err(error);
		}
		return Ok({ id, ...entry, key: await listedKey(secrets, id, entry.kind) });
	});
}

/**
 * Remove connection `id`: its keychain entry first, then its entry and every
 * app's choice of it. Whether there was anything to remove.
 */
export async function removeConnection(
	paths: Pick<AppPaths, 'dataDir' | 'cacheDir'>,
	secrets: SecretStore,
	id: string,
): Promise<Result<{ removed: boolean }, ConnectionsError | SendError>> {
	if (!isConnectionId(id))
		return ConnectionsError.InvalidInput({
			reason: `'${id}' is not a connection id: use letters, digits, '.', '_', and '-'`,
		});
	const { file: path, lock } = locations(paths);
	return exclusively(lock, async () => {
		const { data: file, error: readError } = await readConnectionsFile(path);
		if (readError !== null) return Err(readError);
		const current = file.connections[id];
		// Only an `openai-compatible` connection has a key; with no entry, a
		// key left behind is removed too.
		let keyRemoved = false;
		if (current === undefined || current.kind === 'openai-compatible') {
			const { data, error } = await removeKey(secrets, id);
			if (error !== null) return Err(error);
			keyRemoved = data.removed;
		}
		const apps = Object.fromEntries(
			Object.entries(file.apps).map(([app, uses]) => [
				app,
				Object.fromEntries(
					Object.entries(uses).filter(([, connection]) => connection !== id),
				),
			]),
		);
		const chosen = JSON.stringify(apps) !== JSON.stringify(file.apps);
		if (current === undefined && !chosen) return Ok({ removed: keyRemoved });
		const { [id]: _removed, ...connections } = file.connections;
		const { error: writeError } = await writeConnectionsFile(path, {
			connections,
			apps,
		});
		if (writeError !== null) return Err(writeError);
		return Ok({ removed: true });
	});
}

/**
 * Record that `app` uses connection `id` for `operation`, on this machine.
 * The connection must already be here.
 */
export async function useConnection(
	paths: Pick<AppPaths, 'dataDir' | 'cacheDir'>,
	{ id, app, operation }: { id: string; app: string; operation: string },
): Promise<
	Result<{ app: string; operation: string; id: string }, ConnectionsError>
> {
	const problem = appIdProblem(app);
	if (problem !== undefined)
		return ConnectionsError.InvalidInput({
			reason: `The app id '${app}' ${problem}.`,
		});
	if (!isConnectionId(operation))
		return ConnectionsError.InvalidInput({
			reason: `'${operation}' is not an operation name: use letters, digits, '.', '_', and '-'`,
		});
	const { file: path, lock } = locations(paths);
	return exclusively(lock, async () => {
		const { data: file, error: readError } = await readConnectionsFile(path);
		if (readError !== null) return Err(readError);
		if (file.connections[id] === undefined)
			return ConnectionsError.InvalidInput({
				reason: `There is no connection '${id}' on this computer. Add it with epicenter auth key set first.`,
			});
		const { error } = await writeConnectionsFile(path, {
			...file,
			apps: { ...file.apps, [app]: { ...file.apps[app], [operation]: id } },
		});
		if (error !== null) return Err(error);
		return Ok({ app, operation, id });
	});
}
