import { loadConfig } from './config.ts';
import {
	acquireSyncLock,
	syncOwnerBusy,
	syncOwnerBusyMessage,
} from './lock.ts';
import {
	type MessageWriteOutcome,
	resolveAndModifyMessageLabels,
} from './modify.ts';
import { redeemRefreshToken, runAuthorizationFlow } from './oauth.ts';
import { queryMail } from './query.ts';
import { openLocalMailRuntime, openSyncSession } from './runtime.ts';
import { type MailStatus, readMailStatus } from './status.ts';
import { runSyncLoop, type SyncOutcome, syncMailbox } from './sync.ts';
import { createFileTokenStore } from './token-store.ts';
import { VERSION } from './version.ts';

export type ParsedArgs = {
	command: string;
	positionals: string[];
	full: boolean;
	watch: boolean;
	watchIntervalMs?: number;
	port?: number;
	addLabels: string[];
	removeLabels: string[];
	json: boolean;
	help: boolean;
	version: boolean;
};

const DEFAULT_WATCH_INTERVAL_MS = 30_000;

const HELP = `local-mail: keep a private local copy of Gmail for local tools and agents.

Usage:
  local-mail connect
  local-mail seed-token <refreshToken>
  local-mail sync [--full] [--watch [intervalMs]] [--json]
  local-mail status [--json]
  local-mail query "<sql>"
  local-mail archive|unarchive|mark-read|mark-unread <id...> [--json]
  local-mail label <id...> [--add <label>...] [--remove <label>...] [--json]
  local-mail app [--port <n>]
  local-mail mcp

Commands:
  connect      Connect a Gmail account once using browser OAuth.
  seed-token   Redeem an existing refresh token for headless bootstrap.
               Verifies it against Google; the account email comes from
               the Gmail profile.
  sync         Refresh the local mirror. Use --watch to keep polling.
  status       Show connection state, cursor, and row counts.
  query        Run a read-only SQL query over the local mirror (JSON output).
  archive      Archive messages by removing INBOX, then fold Gmail's response.
  unarchive    Move messages back to the inbox by adding INBOX.
  mark-read    Mark messages read by removing UNREAD.
  mark-unread  Mark messages unread by adding UNREAD.
  label        Add or remove Gmail labels by exact name or id.
  app          Run the desktop runtime host: keep the mirror fresh and serve the triage UI + API on 127.0.0.1. Prints the origin to open.
  mcp          Serve query/status/sync/modify_labels tools over stdio.

Options:
  --full                Force a full pull on the first sync pass.
  --watch [intervalMs]  Keep syncing on a loop. Default: 30000.
  --add <label>         Add a Gmail label by exact name or id. Repeatable.
  --remove <label>      Remove a Gmail label by exact name or id. Repeatable.
  --port <n>            Pin the app server port (app only; default: ephemeral).
  --json                Print typed JSON instead of human text. query is
                        always JSON, so --json is a no-op there.
  -h, --help            Show this help.
  -v, --version         Show version.

Environment:
  GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET   Machine-wide Google OAuth client override.
  LOCAL_MAIL_ACCOUNT                      Account override when multiple are connected.
  LOCAL_MAIL_DIR                          Where the local copy lives.
  LOCAL_MAIL_TOKEN_FILE                   Override the credentials file path.
  LOCAL_MAIL_READ_ONLY                    Disable Gmail mutations.
`;

/**
 * The four triage verbs desugar to a fixed Gmail label change. `label` is the
 * transparent primitive: it takes the same add/remove sets these verbs hide.
 * One core (`resolveAndModifyMessageLabels`) runs all five.
 */
const TRIAGE_VERBS: Record<
	'archive' | 'unarchive' | 'mark-read' | 'mark-unread',
	{ addLabels: string[]; removeLabels: string[]; done: string }
> = {
	archive: { addLabels: [], removeLabels: ['INBOX'], done: 'archived' },
	unarchive: { addLabels: ['INBOX'], removeLabels: [], done: 'moved to inbox' },
	'mark-read': { addLabels: [], removeLabels: ['UNREAD'], done: 'marked read' },
	'mark-unread': {
		addLabels: ['UNREAD'],
		removeLabels: [],
		done: 'marked unread',
	},
};

function parseWatchInterval(input: string): number {
	const value = Number(input.trim());
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			`Invalid --watch interval "${input}". Use a positive number of milliseconds.`,
		);
	}
	return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: '',
		positionals: [],
		full: false,
		watch: false,
		addLabels: [],
		removeLabels: [],
		json: false,
		help: false,
		version: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;
		if (!token.startsWith('-')) {
			if (!args.command) args.command = token;
			else args.positionals.push(token);
			continue;
		}

		const eq = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = eq === -1 ? token : token.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
		const takeValue = (): string => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[i + 1];
			if (next === undefined) throw new Error(`Option ${name} needs a value`);
			i += 1;
			return next;
		};

		switch (name) {
			case '--full':
				args.full = true;
				break;
			case '--watch': {
				args.watch = true;
				// Accept both --watch=5000 and --watch 5000; the space form was
				// previously swallowed into positionals and silently ignored.
				const next = argv[i + 1];
				if (inlineValue !== undefined) {
					args.watchIntervalMs = parseWatchInterval(inlineValue);
				} else if (next !== undefined && !next.startsWith('-')) {
					i += 1;
					args.watchIntervalMs = parseWatchInterval(next);
				}
				break;
			}
			case '--port': {
				const value = Number(takeValue());
				if (!Number.isInteger(value) || value < 0) {
					throw new Error(
						`--port must be a non-negative integer, got "${value}"`,
					);
				}
				args.port = value;
				break;
			}
			case '--add':
				args.addLabels.push(takeValue());
				break;
			case '--remove':
				args.removeLabels.push(takeValue());
				break;
			case '--json':
				args.json = true;
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
			case '-v':
			case '--version':
				args.version = true;
				break;
			default:
				throw new Error(`Unknown option: ${name}`);
		}
	}

	return args;
}

async function runConnect(_args: ParsedArgs): Promise<number> {
	const config = loadConfig();
	const { data: token, error } = await runAuthorizationFlow(config, {
		now: () => Date.now(),
		log: (message) => console.error(message),
	});
	if (error) {
		console.error(`Authentication failed: ${error.message}`);
		return 1;
	}

	const store = createFileTokenStore(config.credentialsPath);
	await store.set(token);
	console.log(`Connected ${token.accountEmail}.`);
	console.log(`Tokens stored in ${config.credentialsPath}.`);
	console.log(`Next: run "local-mail sync --full".`);
	return 0;
}

async function runSeedToken(args: ParsedArgs): Promise<number> {
	const [refreshToken] = args.positionals;
	if (!refreshToken || args.positionals.length > 1) {
		console.error(
			'Usage: local-mail seed-token <refreshToken>\nThe account email is read from the Gmail profile, not typed.',
		);
		return 1;
	}
	const config = loadConfig();
	const { data: token, error } = await redeemRefreshToken(
		config,
		refreshToken,
		() => Date.now(),
	);
	if (error) {
		console.error(`Could not redeem the refresh token: ${error.message}`);
		return 1;
	}
	const store = createFileTokenStore(config.credentialsPath);
	await store.set(token);
	console.log(`Seeded ${token.accountEmail} at ${config.credentialsPath}.`);
	console.log(`Next: run "local-mail sync --full".`);
	return 0;
}

function renderSyncOutcome(outcome: SyncOutcome): string {
	if (outcome.failure) {
		return `Sync failed (${outcome.failure.name}): ${outcome.failure.message}. The cursor did not advance.`;
	}
	const mode = outcome.mode === 'FULL' ? 'Full sync' : 'Incremental sync';
	const labelWord = outcome.labelsPatched === 1 ? 'label' : 'labels';
	const cursor =
		outcome.cursorBefore === outcome.cursorAfter
			? `cursor ${outcome.cursorAfter ?? 'none'}`
			: `cursor ${outcome.cursorBefore ?? 'none'} to ${outcome.cursorAfter ?? 'none'}`;
	return `${mode}: ${outcome.messagesUpserted} upserted, ${outcome.messagesDeleted} deleted, ${outcome.labelsPatched} ${labelWord} patched, ${cursor}.`;
}

async function runSync(args: ParsedArgs): Promise<number> {
	if (args.positionals.length > 0) {
		console.error(
			`sync takes no positional arguments (got: ${args.positionals.join(' ')}).`,
		);
		return 1;
	}
	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	if (runtimeError) {
		console.error(runtimeError.message);
		return 1;
	}

	// Sync is the one operation that needs a single owner per account. If the app
	// (or another sync) already holds the lock, yield cleanly instead of racing a
	// second bulk pull. Reads never take this lock. Triage writes do not take it
	// today because they call Gmail directly, which ADR-0199 withdraws: once a
	// pass is drain-then-pull, this lock is the reconciler lock and is what makes
	// one writer per account true.
	const lock = acquireSyncLock({
		dataDir: runtime.config.dataDir,
		accountEmail: runtime.accountEmail,
	});
	if (!lock) {
		// A busy yield is a terminal outcome, so it goes to stdout like the success
		// and failure summaries do. --json emits the structured payload (discriminated
		// by `synced: false`); the human form is the same one-line note.
		console.log(
			args.json
				? JSON.stringify(syncOwnerBusy(runtime.accountEmail), null, 2)
				: syncOwnerBusyMessage(runtime.accountEmail),
		);
		return 0;
	}

	// Progress goes to stderr so stdout carries only the outcome, keeping
	// --json (and the human summary line) a clean single-value stream.
	const { data: session, error: sessionError } = await openSyncSession(
		runtime,
		{
			gmailLog: (m) => console.error(`[gmail] ${m}`),
			syncLog: (m) => console.error(`[sync] ${m}`),
		},
	);
	if (sessionError) {
		lock.release();
		console.error(sessionError.message);
		return 1;
	}

	try {
		if (!args.watch) {
			const outcome = await syncMailbox(session.deps, { forceFull: args.full });
			console.log(
				args.json
					? JSON.stringify(outcome, null, 2)
					: renderSyncOutcome(outcome),
			);
			return outcome.failure ? 1 : 0;
		}

		const intervalMs = args.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
		console.error(`Watching every ${intervalMs}ms. Ctrl-C to stop.`);
		const controller = new AbortController();
		process.on('SIGINT', () => controller.abort());
		// The exit code reflects the LAST pass, so a supervisor restarting on
		// nonzero sees current health, not a transient failure hours ago.
		let lastPassFailed = false;
		await runSyncLoop(session.deps, {
			forceFull: args.full,
			intervalMs,
			signal: controller.signal,
			onPass: (outcome, pass) => {
				lastPassFailed = outcome.failure !== null;
				if (args.json) {
					console.log(JSON.stringify(outcome));
				} else {
					console.log(`=== pass ${pass} ===`);
					console.log(renderSyncOutcome(outcome));
				}
			},
		});
		return lastPassFailed ? 1 : 0;
	} finally {
		session.close();
		lock.release();
	}
}

/**
 * 0 only when Gmail accepted every id. Any per-id rejection or a systemic
 * abort exits 1 so `local-mail mark-read <id> && next` never proceeds on a
 * mailbox that did not change.
 */
export function modifyExitCode(outcome: MessageWriteOutcome): number {
	const anyFailed = outcome.results.some((result) => result.error !== null);
	return outcome.aborted !== null || anyFailed ? 1 : 0;
}

function renderModifyOutcome(
	outcome: MessageWriteOutcome,
	done: string,
): string {
	const lines = outcome.results.map((result) => {
		if (result.error) return `✗ ${result.id}  ${result.error.message}`;
		const tail = result.folded
			? ''
			: ' (local mirror will catch up on next sync)';
		return `✓ ${result.id}  ${done}${tail}`;
	});
	const ok = outcome.results.filter((result) => result.error === null).length;
	const failed = outcome.results.length - ok;
	lines.push(`${ok} succeeded, ${failed} failed`);
	if (outcome.aborted) {
		lines.push(
			`Aborted after ${outcome.results.length}: ${outcome.aborted.message}`,
		);
	}
	return lines.join('\n');
}

async function runLabelMutation(
	args: ParsedArgs,
	verb: { addLabels: string[]; removeLabels: string[]; done: string },
): Promise<number> {
	if (args.positionals.length === 0) {
		const extra =
			args.command === 'label'
				? ' [--add <label>...] [--remove <label>...]'
				: '';
		console.error(`Usage: local-mail ${args.command} <id...>${extra} [--json]`);
		return 1;
	}

	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	if (runtimeError) {
		console.error(runtimeError.message);
		return 1;
	}
	const { data: session, error: sessionError } = await openSyncSession(runtime);
	if (sessionError) {
		console.error(sessionError.message);
		return 1;
	}

	try {
		const { data, error } = await resolveAndModifyMessageLabels({
			deps: session.deps,
			ids: args.positionals,
			addLabels: verb.addLabels,
			removeLabels: verb.removeLabels,
			readOnly: runtime.config.readOnly,
		});
		if (error) {
			console.error(error.message);
			return 1;
		}
		console.log(
			args.json
				? JSON.stringify(data, null, 2)
				: renderModifyOutcome(data, verb.done),
		);
		return modifyExitCode(data);
	} finally {
		session.close();
	}
}

async function runQuery(args: ParsedArgs): Promise<number> {
	const sql = args.positionals[0];
	if (!sql) {
		console.error('Usage: local-mail query "<sql>"');
		return 1;
	}
	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	if (runtimeError) {
		console.error(runtimeError.message);
		return 1;
	}
	const { data, error } = queryMail({
		dataDir: runtime.config.dataDir,
		accountEmail: runtime.accountEmail,
		sql,
	});
	if (error) {
		console.error(error.message);
		return 1;
	}
	// query is JSON-first by design: an arbitrary SELECT over resource/body_text is
	// not column-shaped, and the rows pipe straight to jq. --json is a no-op.
	console.log(JSON.stringify(data.rows, null, 2));
	const note = data.truncated ? ' (capped; more rows matched)' : '';
	console.error(`${data.rowCount} row${data.rowCount === 1 ? '' : 's'}${note}`);
	return 0;
}

function renderStatus(status: MailStatus): string {
	const accessToken = status.accessToken
		? status.accessToken.valid
			? `valid (expires ${status.accessToken.expiresAt})`
			: `expired (${status.accessToken.expiresAt})`
		: 'none';
	const rows: [string, string][] = [
		['account', status.accountEmail],
		['data dir', status.dataDir],
		['token file', status.tokenFile],
		['connected', status.connected ? 'yes' : 'no'],
		['access token', accessToken],
		['mirror', status.mirror],
		['mirror file', status.mirrorPath],
		[
			'predecessors',
			status.predecessors.length === 0
				? 'none'
				: status.predecessors.map((version) => `v${version}`).join(', '),
		],
		['history cursor', status.historyId ?? 'none'],
		['last full pull', status.lastFullPullAt ?? 'never'],
		['last synced', status.lastSyncedAt ?? 'never'],
		['messages', String(status.rows.messages)],
		['labels', String(status.rows.labels)],
	];
	const width = Math.max(...rows.map(([key]) => key.length));
	return rows
		.map(([key, value]) => `${key.padEnd(width)}  ${value}`)
		.join('\n');
}

async function runStatus(args: ParsedArgs): Promise<number> {
	const { data: runtime, error } = await openLocalMailRuntime();
	if (error) {
		console.error(error.message);
		return 1;
	}
	const status = await readMailStatus(runtime);
	console.log(
		args.json ? JSON.stringify(status, null, 2) : renderStatus(status),
	);
	return 0;
}

export async function runCli(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.version) {
		console.log(VERSION);
		return 0;
	}
	if (args.help || !args.command) {
		console.log(HELP);
		return args.help ? 0 : 1;
	}

	switch (args.command) {
		case 'connect':
			return runConnect(args);
		case 'seed-token':
			return runSeedToken(args);
		case 'sync':
			return runSync(args);
		case 'status':
			return runStatus(args);
		case 'query':
			return runQuery(args);
		case 'archive':
		case 'unarchive':
		case 'mark-read':
		case 'mark-unread':
			return runLabelMutation(args, TRIAGE_VERBS[args.command]);
		case 'label':
			return runLabelMutation(args, {
				addLabels: args.addLabels,
				removeLabels: args.removeLabels,
				done: 'labels updated',
			});
		case 'app': {
			const { runApp } = await import('./app.ts');
			return runApp({ port: args.port });
		}
		case 'mcp': {
			const { runMcpServer } = await import('./mcp.ts');
			return runMcpServer();
		}
		default:
			console.error(`Unknown command: ${args.command}\n`);
			console.log(HELP);
			return 1;
	}
}
