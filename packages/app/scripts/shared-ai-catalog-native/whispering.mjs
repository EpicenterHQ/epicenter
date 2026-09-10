import assert from 'node:assert/strict';

/** Drive the shipped desktop document through DOM events; no application internals are replaced. */
export async function verifyWhispering({
	command,
	evaluate,
	until,
	records,
	endpoint,
	apiKey,
	audioPath,
	model,
	requests,
	evidence,
}) {
	const product = 'whispering';
	const name = 'Native product acceptance';
	const ui = (code) => evaluate(product, code);
	async function click(selector, text) {
		await until(`Whispering control: ${text ?? selector}`, () =>
			ui(`
const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element => ${text === undefined ? 'true' : `element.textContent.trim() === ${JSON.stringify(text)}`});
if (!element || element.disabled) return false;
element.click(); return true;`),
		);
	}
	async function fill(selector, value) {
		await until(`Whispering input: ${selector}`, () =>
			ui(`
const element=document.querySelector(${JSON.stringify(selector)});
if(!element)return false;
element.value=${JSON.stringify(value)};
element.dispatchEvent(new Event('input',{bubbles:true}));
element.dispatchEvent(new Event('change',{bubbles:true}));return true;`),
		);
	}
	await command('launch', { product });
	await until('Whispering Home', () =>
		ui(
			'return Boolean(document.querySelector(\'a[href$="/settings/processing"]\'));',
		),
	);
	await ui(
		"window.acceptanceErrors=[];window.addEventListener('error',event=>acceptanceErrors.push(String(event.error)));window.addEventListener('unhandledrejection',event=>acceptanceErrors.push(String(event.reason)));return true;",
	);
	await click('a[href$="/settings/processing"]');
	await until('transcription picker', () =>
		ui(`
const field=Array.from(document.querySelectorAll('[data-slot="field"]')).find(element=>element.textContent.includes('Transcription connection and model'));
const button=field?.querySelector('button[role="combobox"]');
if(!button)return false;button.click();return true;`),
	);
	await click('[role="option"]', 'Connect a provider...');
	await click('[role="option"]', 'Custom URL');
	await fill('#conn-name', name);
	await fill('#conn-url', endpoint);
	await fill('#conn-key', apiKey);
	await fill('input[aria-label="Model ID"]', model);
	await click('button', 'Add');
	const selected = await until('saved product selection', () =>
		ui(
			"return JSON.parse(localStorage.getItem('whispering.app-ai-selections')??'null')?.selections?.transcription;",
		),
	);
	assert.equal(selected.model, model);
	const shared = await until(
		'product connection reaches another App',
		async () =>
			(await records('so.epicenter.catalog-test-b')).find(
				(entry) => entry.id === selected.connectionId,
			),
	);
	assert.equal(shared.name, name);
	assert.equal(shared.hasApiKey, true);
	assert.equal('apiKey' in shared, false);
	await click('a', 'Home');
	await click('button[aria-label="Switch to upload file"]');
	const bytes = Buffer.from(await Bun.file(audioPath).arrayBuffer());
	const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
	await until('Whispering upload input', () =>
		ui(`
const input=document.querySelector('input[type="file"]');
if(!input)return false;
const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), char=>char.charCodeAt(0));
const transfer=new DataTransfer();transfer.items.add(new File([bytes],'native-product-speech.wav',{type:'audio/wav'}));
input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;`),
	);
	const inference = await until(
		'actual native transcript',
		() => requests.find((request) => request.transcript),
		60_000,
	);
	assert.equal(inference.model, model);
	assert.equal(inference.sha256, sha256);
	assert.equal(inference.authenticated, true);
	const transcriptVisible = () =>
		ui(
			`return Array.from(document.querySelectorAll('textarea')).some(element=>element.value.trim()===${JSON.stringify(inference.transcript.trim())});`,
		);
	await until('Whispering displays transcript', transcriptVisible);
	const text = await ui('return document.body.innerText;');
	await Bun.write(
		`${evidence}/whispering-transcript.txt`,
		`${inference.transcript.trim()}\n\n${text}`,
	);
	// Reload the actual product document and read its persisted selection/result.
	const firstDocument = await ui('return performance.timeOrigin;');
	await ui('setTimeout(()=>location.reload(),100);return true;');
	const secondDocument = await until(
		'Whispering document replaced',
		async () => {
			const origin = await ui('return performance.timeOrigin;');
			return origin !== firstDocument ? origin : undefined;
		},
	);
	await until('Whispering transcript after reload', transcriptVisible);
	assert.deepEqual(
		await ui(
			"return JSON.parse(localStorage.getItem('whispering.app-ai-selections')).selections.transcription;",
		),
		selected,
	);
	await command('destroy', { product });
	return {
		product: 'built Whispering desktop SPA',
		library: 'Local',
		selected,
		sharedConnection: shared,
		inference,
		documents: { first: firstDocument, second: secondDocument },
		transcriptAfterReload: true,
		automation:
			'DOM click/input/change events; existing speech WAV supplied to the file input',
		engine:
			'real cached Whisper Tiny behind a fixture endpoint using Tauri MockRuntime',
	};
}
