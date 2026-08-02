/**
 * Mock Gmail REST server for driving the Local Mail write path WITHOUT touching
 * real Gmail. Point the engine at it with `LOCAL_MAIL_GMAIL_API_BASE`.
 *
 * It reads the *copied* mirror's SQLite (read-only) to know a message's current
 * `labelIds`, then applies the requested add/remove and returns the resulting
 * Gmail message JSON, exactly as real Gmail would. Every modify is appended to
 * a JSONL log so a reviewer can prove which writes happened.
 *
 * Env:
 *   MOCK_PORT   port to bind on 127.0.0.1 (0 => an ephemeral port, printed below)
 *   MOCK_DB     absolute path to the copied `mail.db` (opened read-only)
 *   MOCK_LOG    absolute path for the modify JSONL log (optional)
 *   MOCK_FOLD   "false" => every modify omits `labelIds`, so the reconciler
 *               retires the assertion without folding an answer into the mirror
 *               and the row waits for the next pull; anything else folds
 *
 * Every route other than history-echo and modify returns a NON-retryable 403,
 * which the engine treats as a hard, non-destructive failure. That guarantees
 * the sync loop can never run a FULL pull (which would delete unseen rows) and
 * never wipes labels, so even a copied mirror is safe from this mock.
 *
 * On startup it prints `MOCK_READY <port>` to stdout; harness scripts wait for
 * that line before booting the app.
 */
import { Database } from 'bun:sqlite';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT) || 0;
const DB_PATH = process.env.MOCK_DB;
const LOG_PATH = process.env.MOCK_LOG;
const FOLD = process.env.MOCK_FOLD !== 'false';

if (!DB_PATH) {
	console.error('MOCK_DB is required (path to the copied mail.db).');
	process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const getRaw = db.query<{ raw: string }, [string]>(
	'SELECT raw FROM messages WHERE id = ?',
);

function currentMessage(
	id: string,
): { threadId: string; labelIds: string[] } | null {
	const row = getRaw.get(id);
	if (!row) return null;
	const parsed = JSON.parse(row.raw) as {
		threadId: string;
		labelIds?: string[];
	};
	return { threadId: parsed.threadId, labelIds: parsed.labelIds ?? [] };
}

/** A non-retryable hard error: 403 with no recognized `reason`. */
function forbidden(what: string): Response {
	return new Response(
		JSON.stringify({
			error: { errors: [{ reason: 'mockNoOp' }], message: what },
		}),
		{ status: 403, headers: { 'content-type': 'application/json' } },
	);
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const p = url.pathname;

		// messages.modify — the one write we actually service.
		const modifyMatch = p.match(
			/^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/,
		);
		if (modifyMatch && req.method === 'POST') {
			const id = decodeURIComponent(modifyMatch[1] as string);
			const body = (await req.json().catch(() => null)) as {
				addLabelIds?: string[];
				removeLabelIds?: string[];
			} | null;
			const add = body?.addLabelIds ?? [];
			const remove = body?.removeLabelIds ?? [];
			const cur = currentMessage(id);
			if (!cur) {
				return new Response(
					JSON.stringify({ error: { message: 'not found' } }),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				);
			}
			const next = new Set(cur.labelIds);
			for (const l of remove) next.delete(l);
			for (const l of add) next.add(l);
			const labelIds = [...next];

			if (LOG_PATH) {
				appendFileSync(
					LOG_PATH,
					`${JSON.stringify({ at: new Date().toISOString(), id, add, remove, resultLabelIds: labelIds, folded: FOLD })}\n`,
				);
			}

			// folded:true => return labelIds so the mirror row folds immediately.
			// folded:false => omit labelIds so the reconciler has nothing to fold.
			return json(
				FOLD
					? { id, threadId: cur.threadId, labelIds }
					: { id, threadId: cur.threadId },
			);
		}

		// history.list — echo the cursor with NO `history` key => no changes.
		if (p === '/gmail/v1/users/me/history' && req.method === 'GET') {
			const startHistoryId = url.searchParams.get('startHistoryId') ?? '1';
			return json({ historyId: startHistoryId });
		}

		// Everything else is a deliberate non-retryable no-op: labels.list is
		// logged-and-skipped by the engine (non-destructive), and messages.list /
		// messages.get / profile failing hard means a FULL pull can never wipe the
		// copy.
		return forbidden(`${req.method} ${p}`);
	},
});

console.log(`MOCK_READY ${server.port}`);
