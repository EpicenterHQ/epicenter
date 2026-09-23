/** Browser regression for the actual editor components, store, and body codec. */
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { openIdbBacking } from '../../../../packages/app/src/data/store/browser.js';
import {
	createStoreOverPort,
	type DeclaredData,
	syncEngineOf,
} from '../../../../packages/app/src/data/store/store.js';
import * as Y from '@y/y';
import { ynodeToPmnode } from '@y/prosemirror';
import { mount, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import CodeMirrorEditor from '../../../skills/src/lib/components/editor/CodeMirrorEditor.svelte';
import { honeycrispDefinition } from '../../src/lib/data.js';
import Editor from './EditorHarness.svelte';
import { noteSchema } from '../../src/lib/editor/schema.js';

const definition = defineStore({
	id: 'so.epicenter.editor-rc26-evidence',
	kv: {},
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				body: field.string(),
				content: field.string(),
				'!status': field.string(),
			},
			body: honeycrispDefinition.tables.notes.body,
		}),
		instructions: defineTable({
			fields: { body: field.string() },
			body: plainText(),
		}),
	},
});
const codec = honeycrispDefinition.tables.notes.body!;
async function open() {
	const engine = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		async acquire() {
			const backing = expectOk(
				await openIdbBacking(definition.id, {
					factory: indexedDB,
					keyRange: IDBKeyRange,
				}),
			);
			return {
				data: {
					durable: backing.port,
					loaded: backing.loaded,
					dispose: backing.close,
				},
				error: null,
			};
		},
	});
	expectOk(await engine.ready);
	return {
		...(engine.view as DeclaredData<typeof definition>),
		...engine.store,
		close: engine.close,
	};
}
const data = await open();
const note = data.tables.notes.create({
	title: 'Parent title',
	body: 'metadata',
	content: 'ordinary',
	'!status': 'draft',
});
const body = data.tables.notes.body(note.id)!;
const peer = new Y.Doc();
Y.applyUpdateV2(peer, data.encodeStateSince());
const peerRow = peer.get('tables:notes').getAttr(note.id) as Y.Node;
const peerBody = peerRow.get(0) as Y.Node;
let peerWrites = 0;
peer.on('updateV2', () => {
	peerWrites++;
});
const peerEditor = mount(Editor, {
	target: document.querySelector('#peer')!,
	props: { body: peerBody },
});
let tableEvents = 0;
let bodyEvents = 0;
data.tables.notes.subscribe(() => {
	tableEvents++;
});
data.tables.notes.watch(body, () => {
	bodyEvents++;
});
const editor = mount(Editor, {
	target: document.querySelector('#rich')!,
	props: { body },
});
const instruction = data.tables.instructions.create({
	body: 'instruction metadata',
});
const text = data.tables.instructions.body(instruction.id)!;
const codeMirror = mount(CodeMirrorEditor, {
	target: document.querySelector('#plain')!,
	props: { content: text },
});

export function snapshot() {
	const row = body.parent as Y.Node;
	return {
		fields: data.tables.notes.get(note.id),
		text: ynodeToPmnode(body, noteSchema).textContent,
		stable:
			data.tables.notes.body(note.id) === body &&
			row.length === 1 &&
			row.get(0) === body,
		tableEvents,
		bodyEvents,
		peerWrites,
		emptyBody: body.length === 0,
		emptyPeer: peerBody.length === 0,
		plain: text.toString(),
		plainFields: data.tables.instructions.get(instruction.id),
	};
}
export function remoteMetadata() {
	peerRow.setAttr('title', 'Remote title');
	expectOk(syncEngineOf(data).applyRemote(Y.encodeStateAsUpdateV2(peer)));
}
export function rewrite(markdown: string) {
	data.transact(() => {
		expectOk(codec.rewrite(body, markdown));
	});
}
export function remoteBody() {
	Y.applyUpdateV2(peer, data.encodeStateSince());
	peer.transact(() => {
		expectOk(codec.rewrite(peerBody, '# Remote writing'));
	});
	expectOk(syncEngineOf(data).applyRemote(Y.encodeStateAsUpdateV2(peer)));
}
export function plainMetadata() {
	expectOk(
		data.tables.instructions.update(instruction.id, {
			body: 'changed metadata',
		}),
	);
}
export async function reopen() {
	await unmount(editor);
	await unmount(peerEditor);
	await unmount(codeMirror);
	await data.persistence.flush();
	await data.close();
	const reopened = await open();
	const reopenedBody = reopened.tables.notes.body(note.id)!;
	const row = reopenedBody.parent as Y.Node;
	const result = {
		fields: reopened.tables.notes.get(note.id),
		text: ynodeToPmnode(reopenedBody, noteSchema).textContent,
		soleChild: row.length === 1 && row.get(0) === reopenedBody,
		plain: reopened.tables.instructions.body(instruction.id)!.toString(),
	};
	peer.get('tables:notes').deleteAttr(note.id);
	expectOk(syncEngineOf(reopened).applyRemote(Y.encodeStateAsUpdateV2(peer)));
	if (
		reopened.tables.notes.body(note.id) !== undefined ||
		reopened.tables.notes.get(note.id) !== undefined
	)
		throw new Error('Remote deletion retained row');
	await reopened.close();
	peer.destroy();
	return result;
}
