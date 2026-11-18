import { type ActionOutput, connect } from '@epicenter/app/client';
import type definition from '../epicenter.js';

function element<TElement extends Element>(selector: string) {
	const found = document.querySelector<TElement>(selector);
	if (!found) throw new Error(`Missing writing inbox element: ${selector}`);
	return found;
}

const app = connect<typeof definition>();
type Note = ActionOutput<typeof definition.actions.get>;
const capture = element<HTMLFormElement>('#capture');
const body = element<HTMLTextAreaElement>('#body');
const captureSave = element<HTMLButtonElement>('#capture-save');
const captureStatus = element<HTMLParagraphElement>('#capture-status');
const search = element<HTMLInputElement>('#search');
const listStatus = element<HTMLParagraphElement>('#list-status');
const list = element<HTMLDivElement>('#notes');
const editor = element<HTMLDialogElement>('#editor');
const editBody = element<HTMLTextAreaElement>('#edit-body');
const editStatus = element<HTMLParagraphElement>('#edit-status');
const editSave = element<HTMLButtonElement>('#edit-save');
const reload = element<HTMLButtonElement>('#reload');
const close = element<HTMLButtonElement>('#close');
let selected: Note | undefined;
let capturing = false;
let saving = false;
let request = 0;

function message(element: HTMLElement, text: string, error = false) {
	element.textContent = text;
	element.classList.toggle('error', error);
}

function paragraph(className: string, text: string) {
	const element = document.createElement('p');
	element.className = className;
	element.textContent = text;
	return element;
}

async function load() {
	const current = ++request;
	const { data, error } = await app.search({ query: search.value });
	if (current !== request) return;
	if (error) {
		message(listStatus, error.message, true);
		return;
	}
	list.replaceChildren();
	message(
		listStatus,
		data.length
			? `${data.length} ${data.length === 1 ? 'result' : 'results'}`
			: search.value
				? 'No matching notes.'
				: 'Your first note starts here. Save a thought or a source above.',
	);
	for (const note of data) {
		if ('name' in note) {
			list.append(paragraph('error', note.message));
			continue;
		}
		const article = document.createElement('article');
		article.className = 'note';
		article.append(
			paragraph(
				'note-meta',
				[note.kind, note.project].filter(Boolean).join(' · '),
			),
		);
		article.append(
			paragraph(
				'note-text',
				note.body.length > 280 ? `${note.body.slice(0, 280)}…` : note.body,
			),
		);
		if (note.source)
			article.append(paragraph('note-source', `Source: ${note.source}`));
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'secondary';
		button.textContent = 'Open note';
		button.addEventListener('click', () => {
			void openNote(note.id);
		});
		article.append(button);
		list.append(article);
	}
}

async function openNote(id: string) {
	const { data, error } = await app.get({ id });
	if (error) {
		message(listStatus, error.message, true);
		return;
	}
	selected = data;
	editBody.value = data.body;
	element('#edit-details').textContent = [
		data.kind,
		data.project,
		data.source && `Source: ${data.source}`,
	]
		.filter(Boolean)
		.join(' · ');
	message(editStatus, '');
	reload.hidden = true;
	if (!editor.open) editor.showModal();
	editBody.focus();
}

function canClose() {
	return (
		!saving &&
		(editBody.value === selected?.body ||
			window.confirm('Discard the changes you have not saved?'))
	);
}

body.addEventListener('input', () => {
	captureSave.disabled = capturing || !body.value.trim();
});
body.addEventListener('keydown', (event) => {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		capture.requestSubmit();
	}
});
capture.addEventListener('submit', async (event) => {
	event.preventDefault();
	if (capturing || !body.value.trim()) return;
	capturing = true;
	captureSave.disabled = true;
	const values = new FormData(capture);
	// Keep the submitted text on screen until the action answers; don't clear new typing.
	const submitted = body.value;
	const { error } = await app.add({
		body: submitted,
		kind: String(values.get('kind')) as 'thought' | 'quote' | 'link',
		source: String(values.get('source') ?? '').trim() || undefined,
		project: String(values.get('project') ?? '').trim() || undefined,
	});
	capturing = false;
	if (error) message(captureStatus, error.message, true);
	else {
		if (body.value === submitted) body.value = '';
		message(captureStatus, 'Saved.');
		await load();
		body.focus();
	}
	captureSave.disabled = !body.value.trim();
});

element('#edit-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	if (!selected || saving || !editBody.value.trim()) return;
	if (editBody.value === selected.body) {
		editor.close();
		return;
	}
	saving = true;
	editSave.disabled = true;
	close.disabled = true;
	editBody.readOnly = true;
	const { data, error } = await app.edit({
		id: selected.id,
		old: selected.body,
		new: editBody.value,
	});
	saving = false;
	editSave.disabled = false;
	close.disabled = false;
	editBody.readOnly = false;
	if (error) {
		message(
			editStatus,
			error.name === 'Changed'
				? 'This note changed elsewhere. Your draft is still here. Compare it with the saved file before trying again.'
				: error.message,
			true,
		);
		reload.hidden = error.name !== 'Changed';
		return;
	}
	selected = data;
	editor.close();
	await load();
});
close.addEventListener('click', () => {
	if (canClose()) editor.close();
});
editor.addEventListener('cancel', (event) => {
	if (!canClose()) event.preventDefault();
});
reload.addEventListener('click', () => {
	if (selected) void openNote(selected.id);
});
search.addEventListener('input', () => {
	void load();
});
element('#refresh').addEventListener('click', () => {
	void load();
});
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) void load();
});
void load();
