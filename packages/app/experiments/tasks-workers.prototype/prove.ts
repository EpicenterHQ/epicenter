// Black-box acceptance scenario, not a production test suite. Only synthetic tasks.
import { api, seed } from './source.js';
const origin = process.argv[2] ?? 'http://localhost:8799';
const report: any = { origin, started: new Date().toISOString(), checks: [] };
function check(condition: unknown, label: string) {
	if (!condition) throw new Error(label);
	report.checks.push(label);
	console.log(`PASS ${label}`);
}
const uploaded = await seed(origin);
async function build(whileServing?: string) {
	const pending = api(origin, '/admin/build', {});
	if (whileServing) {
		await Bun.sleep(1000);
		const status: any = (await api(origin, '/admin/status')).value;
		check(
			status.building && status.active === whileServing,
			'Published revision stays selected while next revision builds',
		);
		const started = Date.now();
		const page = await api(origin, `/tasks~${whileServing}/`);
		await action(whileServing, 'list', {});
		report.duringBuild = {
			pageStatus: page.response.status,
			pageAndActionMs: Date.now() - started,
		};
		check(
			page.response.ok,
			'Published UI and actions remain usable during compilation',
		);
	}
	const result = await pending;
	console.log('BUILD', JSON.stringify(result.value));
	return result as typeof result & { value: any };
}
async function action(revision: string, name: string, input: unknown) {
	const result = await api(origin, `/tasks~${revision}/${name}`, input);
	if (!result.response.ok)
		throw new Error(
			`Action HTTP ${result.response.status}: ${result.raw.slice(0, 500)}`,
		);
	const line = JSON.parse(result.raw.trim());
	if (line.answer?.threw || line.answer?.error)
		throw new Error(JSON.stringify(line));
	return line.answer.returned;
}
const first = await build();
check(
	first.response.ok && first.value.ok,
	'V1 compiles raw UI and actions inside workerd',
);
report.first = first.value;
const firstId = first.value.id;
const title = `Worker proof ${Date.now()}`;
const added = await action(firstId, 'add', {
	title,
	notes: 'Synthetic Markdown record',
});
check(
	added.title === title,
	'Original Tasks add action runs in Dynamic Worker',
);
await action(firstId, 'set', { path: added.path, done: true });
await action(firstId, 'note', {
	path: added.path,
	body: 'Notes changed in Workers',
});
const read = await action(firstId, 'get', { path: added.path });
check(
	read.done && read.body === 'Notes changed in Workers',
	'Complete and note actions persist task data',
);
const v2Action = uploaded.files['epicenter.ts'].replace(
	'const heading = first.trim();',
	'const heading = "Cloud: " + first.trim();',
);
check(
	v2Action !== uploaded.files['epicenter.ts'],
	'Action edit applies to actual Tasks source',
);
const v2Ui = uploaded.files['ui/src/pages/List.svelte'].replace(
	/>\s*Tasks\s*</,
	'>Tasks in Workers<',
);
check(
	v2Ui !== uploaded.files['ui/src/pages/List.svelte'],
	'Visible Svelte UI edit applies',
);
await api(origin, '/admin/source', {
	files: {
		'epicenter.ts': v2Action,
		'ui/src/pages/List.svelte': v2Ui,
		'ui/index.html': uploaded.files['ui/index.html'].replace(
			'<title>Tasks</title>',
			'<title>Tasks in Workers</title>',
		),
	},
});
const second = await build(firstId);
check(
	second.response.ok && second.value.ok,
	'V2 builds edited Svelte UI and action together',
);
report.second = second.value;
const id = second.value.id;
const html = await api(origin, `/tasks~${id}/`);
const js = await api(origin, `/tasks~${id}/main.js`);
check(
	html.raw.includes('Tasks in Workers') && js.raw.includes('Tasks in Workers'),
	'V2 serves edited HTML and compiled Svelte',
);
check(
	(await action(id, 'get', { path: added.path })).done,
	'Data survives code revision change',
);
check(
	(await action(id, 'add', { title: 'Edited action' })).title ===
		'Cloud: Edited action',
	'V2 action behavior changed',
);
check(
	(await api(origin, `/tasks~${firstId}/list`, {})).response.status === 409,
	'Stale UI cannot silently call new actions',
);
const icon = await api(origin, `/tasks~${id}/static/icon.svg`);
await api(origin, '/admin/static', {
	files: {
		'/static/icon.svg': Buffer.from('unpublished broken icon').toString(
			'base64',
		),
	},
});
await api(origin, '/admin/source', {
	files: { 'ui/src/pages/List.svelte': '<script>const broken = ;</script>' },
});
const brokenUi = await build();
check(
	brokenUi.response.status === 422 && brokenUi.value.active === id,
	'Broken Svelte build preserves active revision',
);
report.brokenUi = brokenUi.value;
check(
	(await api(origin, `/tasks~${id}/main.js`)).raw === js.raw,
	'Last working UI bundle remains byte-identical',
);
check(
	(await api(origin, `/tasks~${id}/static/icon.svg`)).raw === icon.raw,
	'Unpublished static assets cannot change the working version',
);
await api(origin, '/admin/static', {
	files: { '/static/icon.svg': uploaded.binaries['/static/icon.svg'] },
});
check(
	(await action(id, 'add', { title: 'After broken UI' })).title ===
		'Cloud: After broken UI',
	'Last working actions still execute after broken UI',
);
await api(origin, '/admin/source', {
	files: {
		'ui/src/pages/List.svelte': v2Ui,
		'epicenter.ts': 'export const broken = ;',
	},
});
const brokenAction = await build();
check(
	brokenAction.response.status === 422 && brokenAction.value.active === id,
	'Broken TypeScript build preserves active revision',
);
report.brokenAction = brokenAction.value;
check(
	(await action(id, 'get', { path: added.path })).body ===
		'Notes changed in Workers',
	'Original Markdown data survives both failed builds',
);
await action(id, 'delete', { path: added.path });
check(
	(await action(id, 'list', {})).every((task: any) => task.path !== added.path),
	'Original Tasks delete action works',
);
await api(origin, '/admin/source', { files: { 'epicenter.ts': v2Action } });
report.final = (await api(origin, '/admin/status')).value;
report.completed = new Date().toISOString();
await Bun.write(
	new URL(
		new URL(origin).hostname === 'localhost'
			? './proof-local.json'
			: './proof-cloudflare.json',
		import.meta.url,
	),
	JSON.stringify(report, null, 2),
);
console.log(
	JSON.stringify({
		ok: true,
		checks: report.checks.length,
		origin,
		active: id,
	}),
);
