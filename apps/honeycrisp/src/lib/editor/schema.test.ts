/** The note schema parses attributes from the DOM document it is handed. */
import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { DOMParser } from 'prosemirror-model';
import { noteSchema } from './schema.js';

test('a separate DOM realm preserves task state and code-block language', () => {
	const dom = new JSDOM(`
		<ul class="task-list">
			<li class="task-item" data-checked="true"><p>Done</p></li>
		</ul>
		<pre data-params="ts"><code>const done = true;</code></pre>
	`);
	try {
		const document = DOMParser.fromSchema(noteSchema).parse(
			dom.window.document.body,
		);
		expect(document.firstChild?.type).toBe(noteSchema.nodes.taskList);
		expect(document.firstChild?.firstChild?.attrs.checked).toBe(true);
		expect(document.lastChild?.type).toBe(noteSchema.nodes.code_block);
		expect(document.lastChild?.attrs.params).toBe('ts');
	} finally {
		dom.window.close();
	}
});
