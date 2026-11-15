/** PROTOTYPE: Watch one run and recover its journal entry after reloading. */
import { connect, pendingRuns } from '@epicenter/app/client';
import type demo from './app/epicenter.js';

const app = connect<typeof demo>();
const file = document.querySelector<HTMLInputElement>('#file')!;
const chunks = document.querySelector<HTMLInputElement>('#chunks')!;
const delay = document.querySelector<HTMLInputElement>('#delay')!;
const attachId = document.querySelector<HTMLInputElement>('#attach-id')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const log = document.querySelector<HTMLPreElement>('#events')!;
const id = document.querySelector<HTMLOutputElement>('#run-id')!;
const pending = document.querySelector<HTMLUListElement>('#pending')!;
let current: ReturnType<typeof app.transcribe.attach> | undefined;
let observer: AbortController | undefined;

function print(value: unknown) {
	log.append(document.createTextNode(`${JSON.stringify(value)}\n`));
}

function refresh() {
	pending.replaceChildren();
	document.querySelector('#pending-count')!.textContent =
		`${pendingRuns({ app: 'runs-demo' }).length} recorded runs in this browser`;
	for (const run of app.transcribe.pending()) {
		const item = document.createElement('li');
		item.append(document.createTextNode(`${run.id} (${run.startedAt}) `));
		const attach = document.createElement('button');
		attach.textContent = 'Attach';
		attach.onclick = () => {
			void follow(app.transcribe.attach(run.id));
		};
		item.append(attach);
		pending.append(item);
	}
}

async function follow(run: ReturnType<typeof app.transcribe.attach>) {
	observer?.abort();
	const watching = new AbortController();
	observer = watching;
	current = run;
	id.textContent = run.id;
	log.textContent = '';
	cancel.disabled = false;
	refresh();
	try {
		for await (const event of run.events({ signal: watching.signal })) {
			print(event);
			refresh();
		}
	} catch (cause) {
		print({ error: String(cause) });
	} finally {
		if (observer === watching) cancel.disabled = true;
		refresh();
	}
}

document.querySelector<HTMLFormElement>('#start-form')!.onsubmit = (event) => {
	event.preventDefault();
	const audio = file.files?.[0];
	if (!audio) return;
	void follow(
		app.transcribe.start({
			audio,
			...(chunks.value ? { chunks: Number(chunks.value) } : {}),
			...(delay.value ? { delayMs: Number(delay.value) } : {}),
		}),
	);
};
cancel.onclick = async () => {
	if (current) print({ cancel: await current.cancel() });
};
document.querySelector<HTMLFormElement>('#attach-form')!.onsubmit = (event) => {
	event.preventDefault();
	void follow(app.transcribe.attach(attachId.value.trim()));
};
document.querySelector<HTMLButtonElement>('#refresh')!.onclick = refresh;
window.addEventListener('pagehide', () => observer?.abort());
window.addEventListener('storage', refresh);
refresh();
