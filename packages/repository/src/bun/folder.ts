/**
 * A folder engine in Bun (`folder/engine.ts`): a folder on disk kept as a
 * projection of one replica, with its identity, its replica's place on
 * this machine, one engine per folder, and its connection.
 *
 * ```txt
 * <folder>/.epicenter/repository              the folder's identity (JSON, never synced)
 * <folder>/.epicenter/tmp/                     captures and temporaries (folder/fs.ts)
 * <data>/replicas/<replica id>/replica.sqlite  the replica and the folder's record
 * <data>/replicas/<replica id>/objects/        the device's blob bytes
 * <data>/replicas/<replica id>/folder.json     the folder this replica keeps
 * ```
 *
 * The identity names the repository (`owner/name`, or null for one kept
 * only here), its server, the account, the replica's id and the author
 * label (`--agent`; absent for a person). It holds no secret: the token
 * comes from the caller. The replica lives outside the folder, so a folder
 * inside a file-syncing service never syncs a live SQLite file, and a
 * folder may be moved or renamed freely. The database is held with
 * `PRAGMA locking_mode = EXCLUSIVE`: a second engine over the same replica
 * (a running `sync`) is refused, and a crash releases it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { downloadBlob } from '../client/bytes.js';
import { openReplica, type Replica } from '../client/replica.js';
import { connectSocket } from '../client/socket.js';
import { startUploads } from '../client/uploads.js';
import { createFolderEngine, type FolderEngine } from '../folder/engine.js';
import { OWN } from '../folder/fs.js';
import type { SqlDriver } from '../sql.js';
import { createLfsClient, createWireClient } from '../wire/client.js';
import { createFileBlobStore } from './blobs.js';
import { createBunFolderFs } from './folder-fs.js';
import { socketWithHeaders } from './serve.js';
import { openBunSqlite } from './sqlite.js';

/** Where a folder's identity lives, under the folder Epicenter alone writes. */
const IDENTITY = `${OWN}/repository`;

const IdentitySchema = Type.Object({
	/** `owner/name`, or null for a repository kept only in this folder. */
	repository: Type.Union([Type.String(), Type.Null()]),
	server: Type.Union([Type.String(), Type.Null()]),
	account: Type.Union([Type.String(), Type.Null()]),
	replica: Type.String(),
	agent: Type.Optional(Type.String()),
});
export type Identity = Type.Static<typeof IdentitySchema>;

/** An author label: a letter first, then letters, digits, `-` and `_`. */
const AGENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const FolderError = defineErrors({
	NotAFolder: ({ dir }: { dir: string }) => ({ message: `${dir} is not a folder`, dir }),
	BadIdentity: ({ dir, reason }: { dir: string; reason: string }) => ({ message: `${dir}/${IDENTITY} cannot be read: ${reason}`, dir, reason }),
	BadAgent: ({ agent }: { agent: string }) => ({ message: `"${agent}" is not an author label: a letter first, then letters, digits, - or _`, agent }),
	/** `--agent` names a writer other than the one this folder writes as: its replica's commits name one device, set when it joined. */
	OtherAgent: ({ agent, label }: { agent: string; label: string | null }) => ({
		message: `this folder writes as ${label === null ? 'its person' : label}, not ${agent}; join a folder of its own with --join and --agent ${agent}`,
		agent,
		label,
	}),
	BadAddress: ({ address }: { address: string }) => ({ message: `"${address}" is not a repository address (owner/name)`, address }),
	JoinedElsewhere: ({ dir, repository }: { dir: string; repository: string | null }) => ({
		message: `${dir} already keeps ${repository ?? 'a repository kept only here'}; join from an empty folder, or remove ${IDENTITY} to make it a new one`,
		dir,
		repository,
	}),
	NoToken: () => ({ message: 'This folder syncs with a server: pass --token or set EPICENTER_TOKEN' }),
	Held: ({ dir }: { dir: string }) => ({ message: `${dir} is kept by another engine (a running epicenter sync)`, dir }),
	Copy: ({ dir, original }: { dir: string; original: string }) => ({ message: `this folder is a copy of ${original}; use --join to make it a new folder`, dir, original }),
	Unreachable: ({ server, reason }: { server: string; reason: string }) => ({ message: `${server} could not be reached: ${reason}`, server, reason }),
	Bound: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type FolderError = InferErrors<typeof FolderError>;

/** The machine's data directory, as the desktop resolves it (`packages/cli/src/app-paths.ts`): `EPICENTER_DATA_DIR`, else `~/Library/Application Support/so.epicenter`. */
export function dataDirectory(env: Record<string, string | undefined> = process.env, home = homedir()) {
	const value = env.EPICENTER_DATA_DIR;
	if (value === undefined || value === '') return join(home, 'Library', 'Application Support', 'so.epicenter');
	if (!isAbsolute(value)) throw new Error(`EPICENTER_DATA_DIR must be an absolute path, not '${value}'.`);
	return value;
}
/** The movable root of repository folders: `EPICENTER_FOLDER_DIR`, else `~/Epicenter`. */
export function folderRoot(env: Record<string, string | undefined> = process.env, home = homedir()) {
	const value = env.EPICENTER_FOLDER_DIR;
	if (value === undefined || value === '') return join(home, 'Epicenter');
	if (!isAbsolute(value)) throw new Error(`EPICENTER_FOLDER_DIR must be an absolute path, not '${value}'.`);
	return value;
}

function readIdentity(dir: string): Result<Identity | null, FolderError> {
	const file = join(dir, ...IDENTITY.split('/'));
	if (!existsSync(file)) return Ok(null);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, 'utf8'));
	} catch (cause) {
		return FolderError.BadIdentity({ dir, reason: String(cause) });
	}
	if (!Check(IdentitySchema, parsed)) return FolderError.BadIdentity({ dir, reason: 'it is not an identity' });
	return Ok(parsed);
}
function writeIdentity(dir: string, identity: Identity) {
	mkdirSync(join(dir, OWN), { recursive: true });
	writeFileSync(join(dir, ...IDENTITY.split('/')), `${JSON.stringify(identity, null, '\t')}\n`);
}

/** The children of `root` that hold an identity file: the repository folders. Others (the desktop's app folders among them) are left alone. */
export function listRepositoryFolders(root = folderRoot()) {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => join(root, entry.name))
		.flatMap((dir) => {
			const identity = readIdentity(dir);
			return identity.error === null && identity.data !== null ? [{ dir, identity: identity.data }] : [];
		});
}

/** Ask a server who `token` is: the user its first socket message names. */
async function whoami(url: string, token: string): Promise<Result<{ user: string }, FolderError>> {
	const client = createWireClient({ url, headers: { authorization: `Bearer ${token}` }, openSocket: socketWithHeaders({ authorization: `Bearer ${token}` }) });
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			socket.close();
			resolve(FolderError.Unreachable({ server: url, reason: 'no answer in 10 s' }));
		}, 10_000);
		const socket = client.socket({
			message(message) {
				if (message.type !== 'head') return;
				clearTimeout(timer);
				socket.close();
				resolve(Ok({ user: message.user }));
			},
			closed(code) {
				clearTimeout(timer);
				resolve(FolderError.Unreachable({ server: url, reason: `the socket closed (${code})` }));
			},
		});
	});
}

export type FolderOptions = {
	dir: string;
	/** Join `owner/name` on `server` (a new folder, or a copy made new). */
	join?: { repository: string; server: string };
	/** The author label of every save and commit from this folder (an agent's name): recorded when the folder joins, and refused on a later run that names another. */
	agent?: string;
	/** The account's token (else `EPICENTER_TOKEN`). */
	token?: string;
	dataDir?: string;
	log?: Logger;
	/** How long a live folder's events must be quiet before a file is read. */
	quiet?: number;
	/** Periodic scans while live, in ms (null: none). */
	scanEvery?: number | null;
};

export type OpenedFolder = {
	dir: string;
	identity: Identity;
	/** True when this open made the folder's identity. */
	joined: boolean;
	replica: Replica;
	engine: FolderEngine;
	driver: SqlDriver;
	/** Connect to the server (a folder kept only here has none): the socket and the upload track. */
	connect(): { close(): void; uploads: { idle(): Promise<void>; kick(): void } } | null;
	close(): void;
};

/**
 * Open the folder at `dir`: its identity (made on `join`, or as a
 * repository kept only here when there is none), its replica held
 * exclusively, and a folder engine over them. Nothing connects until
 * `connect`.
 */
export async function openFolderEngine({ dir: given, join: joining, agent, token = process.env.EPICENTER_TOKEN, dataDir = dataDirectory(), log, quiet, scanEvery = null }: FolderOptions): Promise<Result<OpenedFolder, FolderError>> {
	if (!existsSync(given) || !statSync(given).isDirectory()) return FolderError.NotAFolder({ dir: given });
	// The real path: a watch reports names under it, and a copy is told apart by it.
	const dir = realpathSync(given);
	if (agent !== undefined && !AGENT.test(agent)) return FolderError.BadAgent({ agent });
	if (joining !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(joining.repository)) return FolderError.BadAddress({ address: joining.repository });
	const read = readIdentity(dir);
	if (read.error !== null) return read;
	let identity = read.data;
	let joined = false;
	if (identity !== null && joining !== undefined && (identity.repository !== joining.repository || identity.server !== joining.server)) {
		// A copy of a folder (same replica, its original still there) becomes a new folder by joining; any other identity stays what it is.
		if (copyOf(dir, identity, dataDir) === null) return FolderError.JoinedElsewhere({ dir, repository: identity.repository });
		identity = null;
	}
	if (identity === null) {
		let account: string | null = null;
		if (joining !== undefined) {
			if (token === undefined || token === '') return FolderError.NoToken();
			const who = await whoami(joining.server, token);
			if (who.error !== null) return who;
			account = who.data.user;
		}
		identity = { repository: joining?.repository ?? null, server: joining?.server ?? null, account, replica: crypto.randomUUID(), ...(agent === undefined ? {} : { agent }) };
		writeIdentity(dir, identity);
		joined = true;
	} else if (joining !== undefined && copyOf(dir, identity, dataDir) !== null) {
		// --join on a copy of a folder of the same repository: a new folder.
		identity = { ...identity, replica: crypto.randomUUID(), ...(agent === undefined ? {} : { agent }) };
		writeIdentity(dir, identity);
		joined = true;
	}
	const original = copyOf(dir, identity, dataDir);
	if (original !== null) return FolderError.Copy({ dir, original });
	// RULE: `--agent` names who writes on every run, and the replica names one writer for good: one that differs is refused, never ignored.
	if (agent !== undefined && agent !== identity.agent) return FolderError.OtherAgent({ agent, label: identity.agent ?? null });
	if (identity.server !== null && (token === undefined || token === '')) return FolderError.NoToken();

	const home = join(dataDir, 'replicas', identity.replica);
	mkdirSync(home, { recursive: true });
	let driver: SqlDriver;
	try {
		driver = openBunSqlite(join(home, 'replica.sqlite'));
		// RULE: one engine per replica: the database is held for as long as this one runs; a crash releases it.
		driver.exec('PRAGMA locking_mode = EXCLUSIVE');
		// WAL with NORMAL is durable across a crash of this process, and loses at most the last transactions on power loss, never consistency.
		driver.exec('PRAGMA synchronous = NORMAL');
		driver.exec('BEGIN EXCLUSIVE');
		driver.exec('COMMIT');
	} catch {
		return FolderError.Held({ dir });
	}
	writeFileSync(join(home, 'folder.json'), `${JSON.stringify({ folder: dir })}\n`);

	const name = identity.repository?.split('/')[1] ?? basename(dir);
	const opened = openReplica({
		driver,
		binding: { repository: name, server: null, account: identity.account },
		// RULE: the author label names the device in every commit and conflict block (alice/claude); a person's folder is named by its replica.
		device: identity.agent ?? identity.replica.slice(0, 8),
		after: (ms, run) => void setTimeout(run, ms),
		now: () => Date.now(),
	});
	if (opened.error !== null) {
		driver.close();
		return FolderError.Bound({ reason: opened.error.message });
	}
	const replica = opened.data;
	const store = createFileBlobStore(join(home, 'objects'));
	const headers = { authorization: `Bearer ${token ?? ''}` };
	const lfs = identity.server === null ? null : createLfsClient({ url: identity.server, headers });
	const engine = createFolderEngine({
		fs: createBunFolderFs(dir),
		replica,
		driver,
		store,
		fetch: async (path, pointer) => (await downloadBlob({ lfs, store }, path, pointer)).error === null,
		after: (ms, run) => void setTimeout(run, ms),
		now: () => Date.now(),
		...(quiet === undefined ? {} : { quiet }),
		scanEvery,
		...(log === undefined ? {} : { log }),
	});
	const server = identity.server;
	return Ok({
		dir,
		identity,
		joined,
		replica,
		engine,
		driver,
		connect() {
			if (server === null || lfs === null) return null;
			const client = createWireClient({ url: server, headers, openSocket: socketWithHeaders(headers) });
			const socket = connectSocket(replica, client, { retry: 1_000, ...(log === undefined ? {} : { log }) });
			const uploads = startUploads({ replica, store, lfs, ...(log === undefined ? {} : { log }) });
			const stop = replica.watch(() => uploads.kick());
			return {
				uploads,
				close() {
					stop();
					uploads.stop();
					socket.close();
				},
			};
		},
		close() {
			replica.close();
			driver.close();
		},
	});
}

/** The folder `dir` copies, when its replica keeps another folder that still exists with the same identity; else null. */
function copyOf(dir: string, identity: Identity, dataDir: string) {
	const file = join(dataDir, 'replicas', identity.replica, 'folder.json');
	if (!existsSync(file)) return null;
	let kept: string;
	try {
		kept = (JSON.parse(readFileSync(file, 'utf8')) as { folder: string }).folder;
	} catch {
		return null;
	}
	if (kept === dir || !existsSync(kept)) return null;
	const there = readIdentity(kept);
	return there.error === null && there.data?.replica === identity.replica ? kept : null;
}

