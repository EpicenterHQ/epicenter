/**
 * Headless, dependency-free smoke test for the Local Mail write path.
 *
 * One shot, no browser: it stands up the safe stack (throwaway mirror copy with
 * forged creds + mock Gmail + `local-mail app`), reads the runtime host bearer
 * from its presence file, records ONE real triage act through
 * `/api/accounts/:account/messages/assert`, runs the reconciler, and proves the
 * three things the manual browser loop does:
 *   1. the act is visible to the very next read before Gmail hears anything,
 *   2. the reconciler delivered it (a matching line lands in the modify log), and
 *   3. the REAL mirror's durable state is byte-identical before and after.
 *
 * It tears the mock and app down on the way out and exits non-zero on any
 * failure, so it doubles as a regression guard a future developer can just run:
 *
 *   bun run apps/local-mail/test-support/smoke.ts
 *
 * The browser-only affordances (undo toast, shortcuts overlay, keyboard
 * dispatch) are verified by hand against the SPA. This is
 * LOCAL tooling, deliberately not wired into CI: it needs a real connected
 * mirror to copy from.
 */
import { bootHarness, fingerprintReal, readModifyLog } from './boot.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	// Fingerprint the real mirror BEFORE anything runs.
	const before = await fingerprintReal();

	const harness = await bootHarness({ fold: true });
	try {
		const auth = {
			authorization: `Bearer ${harness.bearer}`,
			'content-type': 'application/json',
		};

		// The host serves every connected account; the copy has exactly one.
		const { accounts } = (await (
			await fetch(`${harness.appOrigin}/api/accounts`, { headers: auth })
		).json()) as { accounts: string[] };
		const account = accounts[0];
		if (!account) throw new Error('the mirror copy has no connected account');
		const base = `${harness.appOrigin}/api/accounts/${encodeURIComponent(account)}`;

		// Pick a message and a real label change. Prefer archiving an inbox
		// message; fall back to toggling STARRED on any message.
		const pick = async (query: string) =>
			(
				(await (
					await fetch(`${base}/messages?${query}`, { headers: auth })
				).json()) as { messages: { id: string; labelIds: string[] }[] }
			).messages[0];
		let target = await pick('label=INBOX&limit=1');
		let addLabels: string[] = [];
		let removeLabels: string[] = ['INBOX'];
		if (!target) {
			target = await pick('limit=1');
			if (!target) throw new Error('the mirror copy has no messages to act on');
			const starred = target.labelIds.includes('STARRED');
			addLabels = starred ? [] : ['STARRED'];
			removeLabels = starred ? ['STARRED'] : [];
		}

		// Record the act through the exact route the SPA uses.
		const assertRes = await fetch(`${base}/messages/assert`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ ids: [target.id], addLabels, removeLabels }),
		});
		const assertBody = await assertRes.json();
		if (!assertRes.ok)
			throw new Error(`assert failed: ${JSON.stringify(assertBody)}`);

		// Prove the read surface already reflects it, before Gmail hears anything.
		const detail = (await (
			await fetch(`${base}/messages/${target.id}`, { headers: auth })
		).json()) as { labelIds: string[] };
		for (const label of addLabels) {
			if (!detail.labelIds.includes(label))
				throw new Error(`read surface is missing the asserted ${label}`);
		}
		for (const label of removeLabels) {
			if (detail.labelIds.includes(label))
				throw new Error(`read surface still shows the removed ${label}`);
		}

		// Now let the reconciler deliver it. (The host's own loop would too, on
		// the coalesced wake the act requested; this makes the smoke run
		// deterministic instead of timing-dependent.)
		const reconcileRes = await fetch(`${base}/reconcile`, {
			method: 'POST',
			headers: auth,
		});
		const reconcileBody = await reconcileRes.json();
		if (!reconcileRes.ok)
			throw new Error(`reconcile failed: ${JSON.stringify(reconcileBody)}`);

		// Prove the delivery reached the mock.
		await sleep(200);
		const logged = readModifyLog(harness.mockLog).find(
			(e) => e.id === target.id,
		);
		if (!logged) throw new Error(`no modify for ${target.id} in the mock log`);

		// Prove the real mirror is untouched.
		const after = await fingerprintReal();
		if (after !== before) {
			throw new Error(
				`REAL mirror changed!\nbefore:\n${before}\nafter:\n${after}`,
			);
		}

		console.log('SMOKE PASS');
		console.log(
			`  asserted add=${JSON.stringify(addLabels)} remove=${JSON.stringify(removeLabels)} on ${target.id}, then reconciled`,
		);
		console.log(`  mock logged: ${JSON.stringify(logged)}`);
		console.log(
			`  real mirror fingerprint unchanged (${before.split('\n').length} files)`,
		);
	} finally {
		harness.teardown();
	}
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(
		`SMOKE FAIL: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
}
