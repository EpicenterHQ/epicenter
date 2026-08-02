import { type AssertLabelsOutcome, assertMessageLabels } from './assert.ts';
import { loadConfig } from './config.ts';
import {
	acquireReconcileLock,
	reconcileOwnerBusy,
	reconcileOwnerBusyMessage,
} from './lock.ts';
import { redeemRefreshToken, runAuthorizationFlow } from './oauth.ts';
import { queryMail } from './query.ts';
import {
	type ReconcileDeps,
	type ReconcileOutcome,
	reconcileAccount,
	runReconcileLoop,
} from './reconcile.ts';
import { openAccountSession, openLocalMailRuntime } from './runtime.ts';
import { type MailStatus, readMailStatus } from './status.ts';
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
  local-mail reconcile [--full] [--watch [intervalMs]] [--json]
  local-mail status [--json]
  local-mail query "<sql>"
  local-mail archive|unarchive|mark-read|mark-unread|trash|untrash <id...> [--json]
  local-mail label <id...> [--add <label>...] [--remove <label>...] [--json]
  local-mail app [--port <n>]
  local-mail mcp

Commands:
  connect      Connect a Gmail account once using browser OAuth.
  seed-token   Redeem an existing refresh token for headless bootstrap.
               Verifies it against Google; the account email comes from
               the Gmail profile.
  reconcile    Deliver pending local changes to Gmail, then refresh the mirror.
               Use --watch to keep reconciling on a loop.
  status       Show connection state, cursor, and row counts.
  query        Run a read-only SQL query over the local mirror (JSON output).
  archive      Archive messages by asserting INBOX off.
  unarchive    Move messages back to the inbox by asserting INBOX on.
  mark-read    Mark messages read by asserting UNREAD off.
  mark-unread  Mark messages unread by asserting UNREAD on.
  trash        Move messages to Trash by asserting TRASH on.
  untrash      Restore messages from Trash by asserting TRASH off.
  label        Add or remove Gmail labels by exact name or id.
  app          Run the desktop runtime host: reconcile in the background and serve the triage UI + API on 127.0.0.1. Prints the origin to open.
  mcp          Serve query/status/reconcile/assert_labels tools over stdio.

Every triage verb records the change locally and immediately; a reconcile pass
delivers it to Gmail. If this process can take the account's reconcile lock it
runs one right away, otherwise the open app or the next pass delivers it.

Options:
  --full                Force a full pull on the first reconcile pass.
  --watch [intervalMs]  Keep reconciling on a loop. Default: 30000.
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
 * The triage verbs desugar to a fixed label assertion. `label` is the
 * transparent primitive: it takes the same add/remove sets these verbs hide.
 * Trash is in this table too, because trash is only special at delivery, where
 * Gmail's own endpoint takes over; here it is the `TRASH` label like any other.
 */
const TRIAGE_VERBS: Record<
	'archive' | 'unarchive' | 'mark-read' | 'mark-unread' | 'trash' | 'untrash',
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
	trash: { addLabels: ['TRASH'], removeLabels: [], done: 'moved to trash' },
	untrash: {
		addLabels: [],
		removeLabels: ['TRASH'],
		done: 'restored from trash',
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
	console.log(`Next: run "local-mail reconcile --full".`);
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
	console.log(`Next: run "local-mail reconcile --full".`);
	return 0;
}

function renderReconcileOutcome(outcome: ReconcileOutcome): string {
	const { delivery, pull } = outcome;
	const lines: string[] = [];
	if (delivery.pending > 0 || delivery.failure) {
		const parts = [`${delivery.delivered} delivered`];
		if (delivery.discarded.length > 0) {
			parts.push(`${delivery.discarded.length} refused by Gmail`);
		}
		if (delivery.retained > 0) parts.push(`${delivery.retained} still pending`);
		lines.push(`Delivery: ${parts.join(', ')}.`);
		// The discarded list exists only in this outcome, so print it in full: it
		// is the user's one chance to see what Gmail would not accept.
		for (const dropped of delivery.discarded) {
			lines.push(
				`  dropped ${dropped.want ? '+' : '-'}${dropped.labelId} on ${dropped.messageId} (${dropped.status}): ${dropped.reason}`,
			);
		}
		if (delivery.failure) {
			lines.push(
				`Delivery stopped (${delivery.failure.name}): ${delivery.failure.message}. Nothing was lost; the next pass retries.`,
			);
		}
	}
	if (pull.failure) {
		lines.push(
			`Pull failed (${pull.failure.name}): ${pull.failure.message}. The cursor did not advance.`,
		);
		return lines.join('\n');
	}
	const mode = pull.mode === 'FULL' ? 'Full pull' : 'Incremental pull';
	const labelWord = pull.labelsPatched === 1 ? 'label' : 'labels';
	const cursor =
		pull.cursorBefore === pull.cursorAfter
			? `cursor ${pull.cursorAfter ?? 'none'}`
			: `cursor ${pull.cursorBefore ?? 'none'} to ${pull.cursorAfter ?? 'none'}`;
	lines.push(
		`${mode}: ${pull.messagesUpserted} upserted, ${pull.messagesDeleted} deleted, ${pull.labelsPatched} ${labelWord} patched, ${cursor}.`,
	);
	return lines.join('\n');
}

/** A pass failed if either phase did. Delivery failures count: a supervisor
 * restarting on nonzero should see that Gmail is not hearing about this
 * machine's triage, even though nothing was lost. */
function reconcileFailed(outcome: ReconcileOutcome): boolean {
	return outcome.delivery.failure !== null || outcome.pull.failure !== null;
}

async function runReconcile(args: ParsedArgs): Promise<number> {
	if (args.positionals.length > 0) {
		console.error(
			`reconcile takes no positional arguments (got: ${args.positionals.join(' ')}).`,
		);
		return 1;
	}
	const { data: runtime, error: runtimeError } = await openLocalMailRuntime();
	if (runtimeError) {
		console.error(runtimeError.message);
		return 1;
	}

	// A reconcile is the one operation that needs a single owner per account: it
	// is the only thing that writes to Gmail. If the app (or another pass) holds
	// the lock, yield cleanly. Reads and triage acts never take this lock.
	const lock = acquireReconcileLock({
		dataDir: runtime.config.dataDir,
		accountEmail: runtime.accountEmail,
	});
	if (!lock) {
		// A busy yield is a terminal outcome, so it goes to stdout like the success
		// and failure summaries do. --json emits the structured payload
		// (discriminated by `reconciled: false`); the human form is the same note.
		console.log(
			args.json
				? JSON.stringify(reconcileOwnerBusy(runtime.accountEmail), null, 2)
				: reconcileOwnerBusyMessage(runtime.accountEmail),
		);
		return 0;
	}

	// Progress goes to stderr so stdout carries only the outcome, keeping
	// --json (and the human summary line) a clean single-value stream.
	const { data: session, error: sessionError } = await openAccountSession(
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
			const outcome = await reconcileAccount(session.deps, {
				forceFull: args.full,
				readOnly: runtime.config.readOnly,
			});
			console.log(
				args.json
					? JSON.stringify(outcome, null, 2)
					: renderReconcileOutcome(outcome),
			);
			return reconcileFailed(outcome) ? 1 : 0;
		}

		const intervalMs = args.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
		console.error(`Reconciling every ${intervalMs}ms. Ctrl-C to stop.`);
		const controller = new AbortController();
		process.on('SIGINT', () => controller.abort());
		// The exit code reflects the LAST pass, so a supervisor restarting on
		// nonzero sees current health, not a transient failure hours ago.
		let lastPassFailed = false;
		await runReconcileLoop(session.deps, {
			forceFull: args.full,
			readOnly: runtime.config.readOnly,
			intervalMs,
			signal: controller.signal,
			onPass: (outcome, passNumber) => {
				lastPassFailed = reconcileFailed(outcome);
				if (args.json) {
					console.log(JSON.stringify(outcome));
				} else {
					console.log(`=== pass ${passNumber} ===`);
					console.log(renderReconcileOutcome(outcome));
				}
			},
		});
		return lastPassFailed ? 1 : 0;
	} finally {
		session.close();
		lock.release();
	}
}

/** What a triage verb prints: what was recorded, and what happened to it. The
 * assertion itself cannot fail once it is written, so the delivery half is a
 * report, not a verdict. */
type TriageActReport = {
	act: AssertLabelsOutcome;
	/** The pass this process ran, or null when another owner holds the lock. */
	reconcile: ReconcileOutcome | null;
};

function renderTriageAct(report: TriageActReport, done: string): string {
	const lines = [`${report.act.asserted} change(s) recorded (${done}).`];
	lines.push(
		report.reconcile === null
			? 'Another reconciler owns this account (the app is open, or a pass is running); it delivers this shortly.'
			: renderReconcileOutcome(report.reconcile),
	);
	return lines.join('\n');
}

/**
 * Record a triage act, then deliver it if this process can become the account's
 * reconciler. Exit 0 means the act is durable, not that Gmail has heard: an
 * undelivered assertion is kept, and the next pass (here, the open app, or a
 * later `reconcile`) sends it. Only a refusal, which records nothing, exits
 * nonzero.
 */
async function runTriageAct(
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
	const { data: session, error: sessionError } = await openAccountSession(
		runtime,
		{ gmailLog: (m) => console.error(`[gmail] ${m}`) },
	);
	if (sessionError) {
		console.error(sessionError.message);
		return 1;
	}

	try {
		const deps: ReconcileDeps = session.deps;
		const { data: act, error } = assertMessageLabels({
			deps,
			input: {
				ids: args.positionals,
				addLabels: verb.addLabels,
				removeLabels: verb.removeLabels,
			},
			readOnly: runtime.config.readOnly,
		});
		if (error) {
			console.error(error.message);
			return 1;
		}

		const lock = acquireReconcileLock({
			dataDir: runtime.config.dataDir,
			accountEmail: runtime.accountEmail,
		});
		let reconcile: ReconcileOutcome | null = null;
		if (lock) {
			try {
				reconcile = await reconcileAccount(deps, {
					forceFull: false,
					readOnly: runtime.config.readOnly,
				});
			} finally {
				lock.release();
			}
		}

		const report: TriageActReport = { act, reconcile };
		console.log(
			args.json
				? JSON.stringify(report, null, 2)
				: renderTriageAct(report, verb.done),
		);
		return 0;
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
	// query is JSON-first by design: an arbitrary SELECT over raw/body_text is
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
		['schema version', status.schemaVersion ?? 'none'],
		['history cursor', status.historyId ?? 'none'],
		['last full pull', status.lastFullPullAt ?? 'never'],
		['last synced', status.lastSyncedAt ?? 'never'],
		['messages', String(status.rows.messages)],
		['labels', String(status.rows.labels)],
		['pending changes', String(status.pending.assertions)],
		['oldest pending', status.pending.oldestAssertedAt ?? 'none'],
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
		case 'reconcile':
			return runReconcile(args);
		case 'status':
			return runStatus(args);
		case 'query':
			return runQuery(args);
		case 'archive':
		case 'unarchive':
		case 'mark-read':
		case 'mark-unread':
		case 'trash':
		case 'untrash':
			return runTriageAct(args, TRIAGE_VERBS[args.command]);
		case 'label':
			return runTriageAct(args, {
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
