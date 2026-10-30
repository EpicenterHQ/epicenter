/** Run production browser synchronization against disposable native Git servers. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { createGitServer } from './git-server.js';
import type {} from './sync-client.js';

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		chromium: { type: 'string' },
		firefox: { type: 'string' },
		webkit: { type: 'string' },
		output: { type: 'string' },
	},
});
const bundle = await Bun.build({
	entrypoints: [join(import.meta.dir, 'sync-client.ts')],
	target: 'browser',
	minify: false,
});
if (!bundle.success)
	throw new AggregateError(bundle.logs, 'Browser sync build failed');
const output = bundle.outputs[0];
if (output === undefined) throw new Error('Browser build emitted no client');
const script = await output.text();
const results = [];
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

for (const [name, browserType] of Object.entries({
	chromium,
	webkit,
	firefox,
})) {
	const native = await createGitServer();
	const directory = await mkdtemp(join(tmpdir(), `epicenter-sync-${name}-`));
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/repo.git/'))
				return fetch(
					new Request(new URL(url.pathname + url.search, native.url), request),
				);
			return url.pathname === '/client.js'
				? new Response(script, {
						headers: { 'content-type': 'text/javascript' },
					})
				: new Response(
						'<!doctype html><title>Native Git sync smoke</title><script type="module" src="/client.js"></script>',
						{ headers: { 'content-type': 'text/html' } },
					);
		},
	});
	const executablePath = values[name as 'chromium' | 'webkit' | 'firefox'];
	const launch = () =>
		browserType.launchPersistentContext(directory, {
			headless: true,
			executablePath,
		});
	let context: Awaited<ReturnType<typeof launch>> | undefined;
	try {
		const initial = await native.commit(
			new Map([
				['notes/one.md', '---\na: 0\nb: 0\nextra: 0\n---\nFirst\n\nLast\n'],
			]),
		);
		context = await launch();
		const id = `native-sync-${name}`;
		const a = await context.newPage();
		const b = await context.newPage();
		for (const page of [a, b]) {
			await page.goto(server.url.href);
			await page.waitForFunction(() => globalThis.dataSyncSmoke !== undefined);
			await page.evaluate((id) => dataSyncSmoke.open(id), id);
		}
		const fetched = await a.evaluate(() => dataSyncSmoke.sync());
		check(fetched.ok, 'Initial native fetch failed');
		const first = await a.evaluate(() => dataSyncSmoke.state());
		check(
			first.refs.base === initial && first.refs.head === initial,
			'Initial fetch refs differ',
		);
		await Promise.all(
			[a, b].map((page) => page.evaluate(() => dataSyncSmoke.refresh())),
		);
		await a.evaluate(async () => {
			await dataSyncSmoke.writeFile('.gitignore', '/audio/\n');
			await dataSyncSmoke.writeFile('audio/take.wav', [0, 255, 17]);
			await dataSyncSmoke.syncLoop(1);
		});
		const writes = 25;
		await Promise.all([
			a.evaluate((count) => dataSyncSmoke.write('a', count), writes),
			b.evaluate((count) => dataSyncSmoke.write('b', count), writes),
			a.evaluate(() => dataSyncSmoke.syncLoop(8)),
			b.evaluate(() => dataSyncSmoke.syncLoop(8)),
		]);
		await Promise.all([
			a.evaluate(() => dataSyncSmoke.paragraph('First', 'From tab A')),
			b.evaluate(() => dataSyncSmoke.paragraph('Last', 'From tab B')),
		]);
		// Attempts are bounded. A race can leave work pending for the next attempt.
		await a.evaluate(() => dataSyncSmoke.syncLoop(4));
		await b.evaluate(() => dataSyncSmoke.syncLoop(2));
		const afterTabs = await a.evaluate(() => dataSyncSmoke.state());
		check(
			afterTabs.row?.fields?.a === writes &&
				afterTabs.row.fields?.b === writes &&
				afterTabs.row.body === 'From tab A\n\nFrom tab B\n' &&
				!afterTabs.unsent &&
				afterTabs.refs.base === afterTabs.refs.head,
			'Concurrent saves or paragraphs were lost',
		);
		const shared = await native.git(['show', 'main:notes/one.md']);
		check(
			shared.includes(`a: ${writes}\nb: ${writes}`) &&
				shared.includes('From tab A\n\nFrom tab B\n'),
			'Native Git missed browser changes',
		);

		await a.evaluate(() => dataSyncSmoke.refresh());
		await a.evaluate(() => dataSyncSmoke.set('a', 777));
		await a.evaluate(() => dataSyncSmoke.loseNextPushReply());
		const lost = await a.evaluate(() => dataSyncSmoke.sync());
		check(
			!lost.ok,
			'Dropped receive-pack reply did not report transfer failure',
		);
		const uncertain = await a.evaluate(() => dataSyncSmoke.state());
		const pending = uncertain.refs.head;
		check(
			pending !== null &&
				pending !== uncertain.refs.base &&
				uncertain.lostReply?.status === 200 &&
				uncertain.lostReply.bytes > 0,
			'Exact pending commit or drained native response missing',
		);
		check(
			(await native.git(['rev-parse', 'main'])).trim() === pending,
			'Native Git had not accepted the uncertain push',
		);
		await a.evaluate(() => dataSyncSmoke.collect());
		const retainedPending = await a.evaluate(() => dataSyncSmoke.state());
		check(
			retainedPending.refs.head === pending &&
				retainedPending.refs.base !== pending,
			'Collection lost the uncertain commit',
		);
		const accepted = await native.git(['show', 'main:notes/one.md']);
		const later = await native.commit(
			new Map([['notes/one.md', accepted.replace(/^a: 777$/m, 'a: 888')]]),
			'Later native same-field edit',
		);
		await a.evaluate(() => dataSyncSmoke.set('extra', 999));
		await a.evaluate(async () => {
			await dataSyncSmoke.writeFile('audio/take.wav', [0, 254, 42]);
			await dataSyncSmoke.writeFile('.gitignore', '/audio/\n/cache/\n');
		});
		await a.evaluate(() => dataSyncSmoke.collect());
		const retainedEdits = await a.evaluate(() => dataSyncSmoke.state());
		check(
			retainedEdits.refs.head === pending && retainedEdits.unsent,
			'Collection lost the uncertain commit or newer unsent work',
		);
		await context.close();
		context = await launch();
		const reopened = await context.newPage();
		await reopened.goto(server.url.href);
		await reopened.waitForFunction(
			() => globalThis.dataSyncSmoke !== undefined,
		);
		await reopened.evaluate((id) => dataSyncSmoke.open(id), id);
		const beforeRecovery = await reopened.evaluate(() => dataSyncSmoke.state());
		check(
			beforeRecovery.refs.head === pending && beforeRecovery.unsent,
			'Pending identity or newer local edit was lost across browser reopen',
		);
		await reopened.evaluate(() => dataSyncSmoke.syncLoop(4));
		const final = await reopened.evaluate(() => dataSyncSmoke.state());
		check(
			final.row?.fields?.a === 888 &&
				final.row.fields?.b === writes &&
				final.row.fields?.extra === 999 &&
				final.row.body === 'From tab A\n\nFrom tab B\n' &&
				!final.unsent &&
				final.refs.base === final.refs.head,
			'Recovery replayed an accepted edit or lost newer independent work',
		);
		const history = (await native.git(['rev-list', 'main'])).trim().split('\n');
		check(
			history.filter((oid) => oid === pending).length === 1 &&
				history.includes(later),
			'Native history omitted the accepted pending commit or later native edit',
		);
		await native.git(['merge-base', '--is-ancestor', pending, 'main']);
		const finalSource = await native.git(['show', 'main:notes/one.md']);
		check(
			finalSource.includes('a: 888\nb: 25\nextra: 999') &&
				finalSource.includes('From tab A\n\nFrom tab B\n'),
			'Native final content differs',
		);
		check(
			JSON.stringify(
				await reopened.evaluate(() =>
					dataSyncSmoke.fileBytes('audio/take.wav'),
				),
			) === '[0,254,42]',
			'Ignored audio was lost across sync, collection or profile reopen',
		);
		check(
			(
				await native.git(['rev-list', '--objects', '--all', '--', 'audio'])
			).trim() === '',
			'Ignored audio entered native history',
		);
		check(
			(await native.git(['show', 'main:.gitignore'])) === '/audio/\n/cache/\n',
			'Newer ignore edit was lost',
		);
		await native.git(['fsck', '--strict']);
		results.push({
			browser: name,
			version: context.browser()?.version(),
			acknowledgedSaves: writes * 2 + 8,
			initial,
			uncertain: pending,
			lostReply: uncertain.lostReply,
			laterNative: later,
			final: final.refs.head,
			fields: final.row.fields,
			acceptedCommitOccurrences: history.filter((oid) => oid === pending)
				.length,
			checks: [
				'initial native fetch',
				'two tabs saving during network sync',
				'independent paragraphs',
				'native readback',
				'accepted push with lost reply',
				'later native edit',
				'pending and newer edit survive profile reopen',
				'collection preserves uncertain commit and unsent work',
				'ancestry recovery without replay',
				'ignored binary audio survives sync, GC and profile reopen',
				'ignored audio absent from native history',
				'newer ignore edit survives exact-send settlement',
				'native fsck --strict',
			],
		});
	} finally {
		await context?.close();
		await server.stop(true);
		await native.close();
		await rm(directory, { recursive: true, force: true });
	}
}
const report = {
	recordedAt: new Date().toISOString(),
	bundleSha256: new Bun.CryptoHasher('sha256').update(script).digest('hex'),
	scope:
		'Production browser engine and Git transport against local native smart HTTP. Graceful profile reopen; no forced process crash, phone, quota, or hosted-service gate.',
	results,
};
if (values.output !== undefined)
	await Bun.write(values.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
