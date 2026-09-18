/** Real host session, two SPA documents, SSE, persistence and SDK routing. Run from repo root. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createAiCatalog } from '../../../apps/epicenter/src/ai-catalog.ts';
import { createProcessMemoryAppSecrets } from '../../../apps/epicenter/src/app-secrets.ts';
import { createHomeServer } from '../../../apps/epicenter/src/server.ts';
import { createHomeHost } from '../../../apps/epicenter/src/host.ts';
import { createTestDesktopAuth } from '../../../apps/epicenter/src/test-home-host.ts';
import { BOOTSTRAP_ROUTE } from '../../../apps/epicenter/src/routes.ts';

const evidence = await mkdtemp(join(tmpdir(), 'shared-ai-catalog-browser-'));
const root = join(import.meta.dir, '../../..');
const entry = join(evidence, 'entry.ts');
await writeFile(entry, `
import { createAppAi } from ${JSON.stringify(join(root, 'packages/app/src/ai.ts'))};
import { createDesktopAiConnections } from ${JSON.stringify(join(root, 'packages/app/src/ai-connections.epicenter-host.ts'))};
import { createBrowserInferenceSelections } from ${JSON.stringify(join(root, 'packages/app-shell/src/inference-selections.ts'))};
const product = location.pathname.includes('vocab') ? 'vocab' : 'whispering';
const lifetime = new AbortController();
const owner = createAppAi({lifetime:{signal:lifetime.signal,assertUsable(){lifetime.signal.throwIfAborted()}},account:null,runtime:null,connections:createDesktopAiConnections({})});
const app = owner.value;
const selections = createBrowserInferenceSelections(product);
let retained;
window.acceptance = {
 ready: owner.ready,
 records() { return app.ai.connections.getAll().map(({client,...record})=>record); },
 add(input) { return app.ai.connections.add(input); },
 update(id,patch) { return app.ai.connections.update(id,patch); },
 remove(id) { return app.ai.connections.remove(id); },
 select(target) { selections.set('chat',target); },
 selected() { return selections.get('chat'); },
 retain(id) { retained=app.ai.connections.get(id).client; },
 async run(id) { return (await app.ai.connections.get(id).client.models.list()).data; },
 async runRetained() { try { await retained.models.list(); return 'sent'; } catch { return 'retired'; } },
 async preview(baseUrl,apiKey) { return (await app.ai.connections.preview({baseUrl,apiKey}).models.list()).data; },
 async close() { selections[Symbol.dispose](); lifetime.abort(); await owner.close(); },
};
await owner.ready;
document.body.textContent=product+' catalog ready';
`);
const build = await Bun.build({ entrypoints: [entry], target: 'browser', minify: false });
assert.equal(build.success, true, String(build.logs));
const code = await build.outputs[0].text();
const page = `<!doctype html><title>Shared AI catalog</title><body><script type="module">${code.replaceAll('</script', '<\\/script')}</script></body>`;
const requests = [];
const secrets = createProcessMemoryAppSecrets();
const catalog = await createAiCatalog({ dataRoot: evidence, secrets, fetch: async (input, init) => {
	const request = new Request(input, init);
	requests.push({ url: request.url, key: request.headers.get('authorization'), cookie: request.headers.get('cookie') });
	return Response.json({data:[{id:'manual'}]}, {headers:{'set-cookie':'provider=must-not-escape'}});
} });
const host = await createHomeHost({ model: 'unused', engine: async function* () {} });
const auth = createTestDesktopAuth();
let route;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => route.fetch(request) });
const origin = server.url.origin;
route = createHomeServer({
	folderRoot: evidence, host, origin, launchToken: 'test-launch-token', desktopAuth: auth,
	staticAssets: { homePage: '<!doctype html>Home', applications: ['whispering','vocab'].map(id=>({id,title:id,page,resolve:async()=>undefined})) },
	blobs() { throw new Error('No library blobs used by this acceptance.'); }, blobRemote:()=>null, aiCatalog:catalog,
}).app;
let browser;
const errors = [];
let eventRequests = 0;
try {
	assert.equal((await fetch(`${origin}/_epicenter/ai/no-account/connections`)).status, 401);
	const boot = await fetch(BOOTSTRAP_ROUTE.url(origin), {method:'POST',headers:{origin,authorization:'Bearer test-launch-token'}});
	assert.equal(boot.status, 204);
	const cookie = boot.headers.get('set-cookie').split(';')[0];
	assert.equal((await fetch(`${origin}/_epicenter/ai/no-account/connections`, {method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403);
	assert.equal((await fetch(`${origin}/_epicenter/ai/no-account/connections`, {method:'POST',headers:{cookie,origin:'https://untrusted.example','content-type':'application/json'},body:'{}'})).status,403);
	assert.equal((await fetch(`${origin}/_epicenter/ai/no-account/connections`, {method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({type:'import',source:'old',records:[]})})).status,400);
	browser = await chromium.launch({headless:true});
	const context = await browser.newContext();
	context.on('request', request => { if (request.url().endsWith('/_epicenter/ai/no-account/events')) eventRequests++; });
	await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
	await context.addInitScript(() => {
		if (localStorage.getItem('seeded')) return;
		localStorage.setItem('whispering.app-ai-connections',JSON.stringify({version:1,connections:[{id:'legacy-one',name:'Existing endpoint',baseUrl:'https://legacy.example/v1',apiKey:'legacy-key',models:['manual']}]}));
		localStorage.setItem('whispering.app-ai-selections',JSON.stringify({version:1,selections:{chat:{connectionId:'legacy-one',model:'manual'}}}));
		localStorage.setItem('seeded','yes');
	});
	const whispering = await context.newPage();
	const vocab = await context.newPage();
	for (const tab of [whispering,vocab]) tab.on('pageerror', error => errors.push(error.message));
	await Promise.all([whispering.goto(`${origin}/apps/whispering/`),vocab.goto(`${origin}/apps/vocab/`)]);
	for (const tab of [whispering,vocab]) { await tab.waitForFunction(()=>window.acceptance); await tab.evaluate(()=>window.acceptance.ready); }
	for (const tab of [whispering,vocab]) assert.deepEqual(await tab.evaluate(()=>window.acceptance.records()),[]);
	const legacy = await whispering.evaluate(()=>[localStorage.getItem('whispering.app-ai-connections'),localStorage.getItem('whispering.app-ai-selections')]);
	assert.equal(await whispering.evaluate(()=>window.acceptance.selected()),null);
	assert.equal(await vocab.evaluate(()=>window.acceptance.selected()),null);
	// Remain idle beyond Bun's default HTTP timeout; SSE heartbeats keep both subscriptions open.
	await new Promise(resolve=>setTimeout(resolve,12_000));
	assert.equal(eventRequests,2);
	const id = await vocab.evaluate(()=>window.acceptance.add({baseUrl:'https://shared.example/v1',apiKey:'shared-key',models:['manual']}));
	const removable = await vocab.evaluate(()=>window.acceptance.add({baseUrl:'https://second.example/v1',models:['manual']}));
	await whispering.evaluate(id=>window.acceptance.select({connectionId:id,model:'manual'}),removable);
	await vocab.evaluate(id=>window.acceptance.select({connectionId:id,model:'manual'}),id);
	await whispering.waitForFunction(id=>window.acceptance.records().some(record=>record.id===id),id);
	const record = await whispering.evaluate(id=>window.acceptance.records().find(record=>record.id===id),id);
	assert.equal(record.hasApiKey,true); assert.equal('apiKey' in record,false);
	await whispering.evaluate(id=>window.acceptance.retain(id),id);
	await whispering.evaluate(id=>window.acceptance.run(id),id);
	assert.deepEqual(requests.at(-1),{url:'https://shared.example/v1/models',key:'Bearer shared-key',cookie:null});
	await vocab.evaluate(id=>window.acceptance.update(id,{name:'Renamed'}),id);
	await whispering.waitForFunction(id=>window.acceptance.records().find(record=>record.id===id)?.name==='Renamed',id);
	assert.equal(await whispering.evaluate(()=>window.acceptance.runRetained()),'sent');
	await vocab.evaluate(id=>window.acceptance.update(id,{apiKey:'rotated-key'}),id);
	await whispering.waitForFunction(({id,version})=>window.acceptance.records().find(record=>record.id===id)?.accessVersion!==version,{id,version:record.accessVersion});
	assert.equal(await whispering.evaluate(()=>window.acceptance.runRetained()),'retired');
	await whispering.evaluate(id=>window.acceptance.run(id),id);
	assert.equal(requests.at(-1).key,'Bearer rotated-key');
	await vocab.evaluate(()=>window.acceptance.preview('https://preview.example/v1','preview-key'));
	assert.equal(requests.at(-1).key,'Bearer preview-key');
	await vocab.evaluate(id=>window.acceptance.remove(id),removable);
	await whispering.waitForFunction(id=>!window.acceptance.records().some(record=>record.id===id),removable);
	await whispering.evaluate(()=>window.acceptance.close());
	await whispering.reload(); await whispering.waitForFunction(()=>window.acceptance); await whispering.evaluate(()=>window.acceptance.ready);
	assert.equal((await whispering.evaluate(()=>window.acceptance.records())).some(record=>record.id==='legacy-one'),false);
	assert.equal((await whispering.evaluate(()=>window.acceptance.records())).some(record=>record.id===removable),false);
	assert.deepEqual(await whispering.evaluate(()=>window.acceptance.selected()),{connectionId:removable,model:'manual'});
	assert.deepEqual(await vocab.evaluate(()=>window.acceptance.selected()),{connectionId:id,model:'manual'});
	assert.deepEqual(await whispering.evaluate(()=>[localStorage.getItem('whispering.app-ai-connections'),localStorage.getItem('whispering.app-ai-selections')]),legacy);
	assert.equal((await context.cookies()).some(cookie=>cookie.name==='provider'),false);
	const metadata=await readFile(join(evidence,'ai/no-account/connections.json'),'utf8');
	for (const key of ['legacy-key','shared-key','rotated-key','preview-key']) assert.equal(metadata.includes(key),false);
	await Promise.all([whispering.evaluate(()=>window.acceptance.close()),vocab.evaluate(()=>window.acceptance.close())]);
	assert.deepEqual(errors,[]);
	await catalog.close();
	const reopened=await createAiCatalog({dataRoot:evidence,secrets});
	assert.equal(reopened.getAll().connections.some(record=>record.id===id),true);
	assert.equal(reopened.getAll().connections.some(record=>record.id==='legacy-one'),false);
	assert.equal(reopened.getAll().connections.some(record=>record.id===removable),false);
	await reopened.close();
	await writeFile(join(evidence,'result.json'),JSON.stringify({passed:true,checks:['host session and Origin enforcement','obsolete import command rejected','two test SPA documents','idle SSE heartbeat','initial catalog and live updates','legacy values retained without adoption','independent explicit selections','key isolation','rotation retirement','preview','reload without deleted connection resurrection','catalog reopen'],requests:requests.map(({key,...request})=>({...request,authenticated:Boolean(key)})),errors},null,2));
	process.stdout.write(`Shared desktop AI browser acceptance passed: ${evidence}\n`);
} finally {
	await browser?.close(); await catalog.close(); await server.stop(true); auth[Symbol.dispose](); await host[Symbol.asyncDispose]();
}
