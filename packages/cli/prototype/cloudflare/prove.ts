// Black-box acceptance against the real 0.4 client and synthetic Tasks records.

import { connect, runs } from './fixture/app-runtime/src/client.js';
import { api, seed } from './source.js';

const origin = process.argv[2] ?? 'http://localhost:8799';
const lifecycle = runs as any;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${Bun.env.TASKS_PROTOTYPE_TOKEN}`);
	return originalFetch(input, { ...init, headers });
}) as typeof fetch;
const report: any = {
	origin,
	apiVersion: '0.4.0',
	started: new Date().toISOString(),
	checks: [],
};
function check(condition: unknown, label: string) {
	if (!condition) throw new Error(label);
	report.checks.push(label);
	console.log('PASS ' + label);
}
const pause = (ms: number) => Bun.sleep(ms);
async function until<T>(
	read: () => Promise<T>,
	fits: (value: T) => boolean,
	timeout = 20000,
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await read();
		if (fits(value)) return value;
		await pause(150);
	}
	throw new Error('Timed out waiting for expected state');
}
async function status(id: string) {
	return (await api(origin, `/.runs/tasks/review/${id}`)).value as any;
}
async function effect(key: string) {
	const data = (await api(origin, '/admin/data')).value as any[];
	const row = data.find((row) => row.path === `data/reviews/${key}.json`);
	return row ? JSON.parse(row.text) : undefined;
}
function client(revision: string) {
	return connect<any>({
		app: 'tasks',
		url: `${origin}/tasks~${revision}/`,
	}) as any;
}
async function built() {
	const r = await api(origin, '/admin/build', {});
	const value = r.value as any;
	console.log(
		'BUILD',
		JSON.stringify({
			status: r.response.status,
			id: value.id,
			ok: value.ok,
			elapsedMs: value.elapsedMs,
			error: value.error,
		}),
	);
	return { ...r, value };
}
async function value(promise: Promise<any>) {
	const r = await promise;
	if (r.error) throw new Error(JSON.stringify(r.error));
	return r.data;
}
const uploaded = await seed(origin);
const first = await built();
check(
	first.response.ok && first.value.apiVersion === '0.4.0',
	'Raw Tasks UI and current 0.4 runtime compile inside Workers',
);
report.first = first.value;
const v1 = first.value.id;
const app = client(v1);
const task = await value(
	app.add({ title: 'Task from API 0.4', notes: 'Synthetic record' }),
);
await value(app.set({ time: task.time, done: true, was: { done: false } }));
await value(
	app.set({
		time: task.time,
		edit: { old: 'Synthetic record', new: 'Current Result API' },
	}),
);
check(
	(await value(app.get({ time: task.time }))).done,
	'Real Tasks add, guarded set, body edit and get return current Results',
);
const refused = await app.add({ title: 42 });
check(
	refused.error?.name === 'Refused',
	'Invalid input is refused before execution',
);

const key = crypto.randomUUID();
const input = { key, steps: 8, delayMs: 250 };
const run = lifecycle.start(app.review, input);
const observer = new AbortController();
const waiting = run.result({ signal: observer.signal });
await until(
	() => effect(key),
	(e) => e?.effects >= 1,
);
observer.abort();
check(
	(await waiting).error?.name === 'Stopped',
	'Stopping observation does not request host cancellation',
);
await until(
	() => status(run.id),
	(s) => s.state === 'finished',
);
const replay: any[] = [];
for await (const event of lifecycle.attach(app.review, run.id).events())
	replay.push(event);
check(
	replay[0]?.type === 'accepted' &&
		replay[0]?.seq === 1 &&
		replay.at(-1)?.type === 'finished',
	'A new 0.4 observer replays the run from the beginning',
);
check(
	replay.filter((e) => e.type === 'yielded').length === 8,
	'All progress is persisted and replayed after disconnection',
);
check(
	(await effect(key)).starts === 1 && (await effect(key)).effects === 8,
	'Disconnected execution finishes without repeating effects',
);
const joined = await api(origin, `/.runs/tasks/review/${run.id}`, input);
check(
	joined.response.ok && (await effect(key)).starts === 1,
	'Repeated admission joins the accepted run instead of executing again',
);
check(
	(await api(origin, `/.runs/tasks/review/${run.id}`, { ...input, steps: 9 }))
		.response.status === 409,
	'Reusing a run id with different input is refused',
);

const reversed = await api(origin, `/.runs/tasks/review/${run.id}`, {
	delayMs: 250,
	steps: 8,
	key,
});
check(
	reversed.response.ok && (await effect(key)).starts === 1,
	'Equivalent JSON input with reordered keys joins the existing run',
);
const invalidId = crypto.randomUUID();
const invalid = await api(origin, `/.runs/tasks/add/${invalidId}`, {
	title: 42,
});
check(
	invalid.response.status === 400 &&
		invalid.response.headers.get('x-epicenter-admitted') === 'false' &&
		(await api(origin, `/.runs/tasks/add/${invalidId}`)).response.status ===
			404,
	'Wrong-type input is refused before a run or effect is created',
);
const malformed = lifecycle.start(app['invalid-progress'], {});
const malformedAnswer = await malformed.result();
const safeEvents: any[] = [];
for await (const event of malformed.events()) safeEvents.push(event);
check(
	malformedAnswer.error?.name === 'Threw' &&
		safeEvents.at(-1)?.type === 'finished' &&
		!safeEvents.some((e) => e.type === 'yielded'),
	'An invalid yield fails cleanly and leaves the terminal event replayable',
);

const cancelKey = crypto.randomUUID();
const cancelling = lifecycle.start(app.review, {
	key: cancelKey,
	steps: 30,
	delayMs: 250,
});
const cancelAnswer = cancelling.result();
await until(
	() => effect(cancelKey),
	(e) => e?.effects >= 2,
);
check(
	(await cancelling.cancel()).error === null,
	'Explicit cancellation is acknowledged',
);
const stopped = await cancelAnswer;
check(
	stopped.error?.name === 'Stopped',
	'Cancellation reaches callSignal and returns the action stopped Result',
);
const cancelEvents: any[] = [];
for await (const event of cancelling.events()) cancelEvents.push(event);
check(
	cancelEvents.some((e) => e.type === 'cancel-requested'),
	'Cancellation request is recorded before the terminal answer',
);
const cancelled = await effect(cancelKey);
await pause(800);
check(
	JSON.stringify(await effect(cancelKey)) === JSON.stringify(cancelled) &&
		cancelled.completed === 0,
	'Cancelled work stops producing further effects',
);
report.cancelled = { id: cancelling.id, effects: cancelled };

const interruptedKey = crypto.randomUUID();
const interrupted = lifecycle.start(app.review, {
	key: interruptedKey,
	steps: 40,
	delayMs: 500,
});
await until(
	() => effect(interruptedKey),
	(e) => e?.effects >= 2,
);
try {
	await api(origin, '/admin/interrupt', {});
} catch {
	/* The real DO abort intentionally severs this request. */
}
await until(
	() => status(interrupted.id),
	(s) => s.state === 'interrupted',
);
const interruptedAt = Date.now();
const interruptedEffects = await effect(interruptedKey);
const interruptedEvents: any[] = [];
for await (const event of lifecycle.attach(app.review, interrupted.id).events())
	interruptedEvents.push(event);
check(
	interruptedEvents.at(-1)?.type === 'interrupted',
	'A real Durable Object abort recovers the accepted run as interrupted',
);
check(
	interruptedEvents.filter((e) => e.type === 'started').length === 1,
	'Recovery never starts the interrupted action again',
);
report.interrupted = { id: interrupted.id, effects: interruptedEffects };

const actionV2 = uploaded.files['epicenter.ts'].replace(
	'const heading = first.trim();',
	'const heading = "Cloud: " + first.trim();',
);
const uiV2 = uploaded.files['ui/src/pages/List.svelte'].replace(
	/>\s*Tasks\s*</,
	'>Tasks in Workers<',
);
check(
	actionV2 !== uploaded.files['epicenter.ts'] &&
		uiV2 !== uploaded.files['ui/src/pages/List.svelte'],
	'Edits apply to the actual Tasks actions and Svelte heading',
);
await api(origin, '/admin/source', {
	files: { 'epicenter.ts': actionV2, 'ui/src/pages/List.svelte': uiV2 },
});
const pinnedKey = crypto.randomUUID();
const pinned = lifecycle.start(app.review, {
	key: pinnedKey,
	steps: 40,
	delayMs: 1000,
});
await until(
	() => effect(pinnedKey),
	(e) => e?.effects >= 1,
);
const pending = built();
await pause(1000);
const during: any = (await api(origin, '/admin/status')).value;
check(
	during.building && (await value(app.list({}))).length > 0,
	'Published Tasks remains available while the edited revision compiles',
);
const second = await pending;
check(second.response.ok, 'Edited Svelte and actions publish together');
report.second = second.value;
const v2 = second.value.id;
const next = client(v2);
const pinStatus = await status(pinned.id);
check(
	pinStatus.revision === v1,
	'An admitted run stays pinned to its original app revision',
);
check(
	(await value(next.add({ title: 'Edited action' }))).title ===
		'Cloud: Edited action',
	'The newly published action executes its edited code',
);
check(
	(await app.add({ title: 'Stale page' })).error?.name === 'Refused',
	'A stale page cannot silently start a call against a new action revision',
);
check(
	(await pinned.result()).error === null,
	'The old revision run can still finish and be observed after promotion',
);
const bundle = (await api(origin, `/tasks~${v2}/main.js`)).raw;
const icon = (await api(origin, `/tasks~${v2}/static/icon.svg`)).raw;
await api(origin, '/admin/static', {
	files: {
		'/static/icon.svg': Buffer.from('unpublished icon').toString('base64'),
	},
});
await api(origin, '/admin/source', {
	files: { 'ui/src/pages/List.svelte': '<script>const broken = ;</script>' },
});
const brokenUi = await built();
check(
	brokenUi.response.status === 422 && brokenUi.value.active === v2,
	'Broken Svelte preserves the published revision',
);
report.brokenUi = brokenUi.value;
check(
	(await api(origin, `/tasks~${v2}/main.js`)).raw === bundle &&
		(await api(origin, `/tasks~${v2}/static/icon.svg`)).raw === icon,
	'Published JavaScript and static assets survive the failed build unchanged',
);
check(
	(await value(next.add({ title: 'After failed build' }))).title ===
		'Cloud: After failed build',
	'Published 0.4 actions still work after a failed build',
);
await api(origin, '/admin/source', {
	files: {
		'ui/src/pages/List.svelte': uiV2,
		'epicenter.ts': 'export const broken = ;',
	},
});
const brokenTs = await built();
check(
	brokenTs.response.status === 422 && brokenTs.value.active === v2,
	'Broken TypeScript also preserves the published revision',
);
report.brokenAction = brokenTs.value;
await api(origin, '/admin/source', { files: { 'epicenter.ts': actionV2 } });
await api(origin, '/admin/static', {
	files: { '/static/icon.svg': uploaded.binaries['/static/icon.svg'] },
});
if (Date.now() - interruptedAt < 22000)
	await pause(22000 - (Date.now() - interruptedAt));
check(
	JSON.stringify(await effect(interruptedKey)) ===
		JSON.stringify(interruptedEffects),
	'Interrupted effects stay unchanged beyond the original action completion window',
);
check(
	(await effect(interruptedKey)).starts === 1,
	'Interruption and later builds never repeat the action start effect',
);
check(
	(await value(next.get({ time: task.time }))).body.includes(
		'Current Result API',
	),
	'Task data survives successful revisions, interruption and failed builds',
);
await value(next.delete({ time: task.time }));
report.completed = new Date().toISOString();
report.final = (await api(origin, '/admin/status')).value;
await Bun.write(
	origin.includes('localhost') ? 'proof-local.json' : 'proof-cloudflare.json',
	JSON.stringify(report, null, 2),
);
console.log(
	JSON.stringify({
		ok: true,
		checks: report.checks.length,
		origin,
		active: v2,
	}),
);
