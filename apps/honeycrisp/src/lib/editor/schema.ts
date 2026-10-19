/**
 * The bounded ProseMirror schema for a note's body.
 *
 * It holds exactly what `markdown.ts` can write and read back: paragraphs,
 * headings, quotes, code blocks, bullet, ordered, and task lists, rules, hard
 * breaks, and the bold, italic, strikethrough, code, and link marks. There is
 * no underline and no image: Markdown has no underline, and an image would
 * need file handling this editor does not have. Source that needs more stays
 * in the Source view.
 */
import { type MarkSpec, type NodeSpec, Schema } from 'prosemirror-model';
import {
	marks as basicMarks,
	nodes as basicNodes,
} from 'prosemirror-schema-basic';
import { bulletList, listItem, orderedList } from 'prosemirror-schema-list';

const taskList = {
	group: 'block',
	content: 'taskItem+',
	parseDOM: [{ tag: 'ul.task-list' }],
	toDOM: () => ['ul', { class: 'task-list' }, 0],
} satisfies NodeSpec;

const taskItem = {
	content: 'paragraph block*',
	attrs: { checked: { default: false } },
	defining: true,
	parseDOM: [
		{
			tag: 'li.task-item',
			getAttrs: (dom) => {
				return { checked: dom.dataset.checked === 'true' };
			},
		},
	],
	toDOM: (node) => [
		'li',
		{
			class: 'task-item',
			'data-checked': node.attrs.checked ? 'true' : 'false',
		},
		[
			'label',
			{ contenteditable: 'false' },
			[
				'input',
				{
					type: 'checkbox',
					checked: node.attrs.checked ? 'checked' : undefined,
				},
			],
		],
		['div', 0],
	],
} satisfies NodeSpec;

const strike = {
	parseDOM: [
		{ tag: 's' },
		{ tag: 'del' },
		{ tag: 'strike' },
		{ style: 'text-decoration=line-through' },
	],
	toDOM: () => ['s', 0],
} satisfies MarkSpec;

/**
 * A code block that keeps the text after its opening fence (`ts` in
 * ```` ```ts ````). The basic schema's code block has nowhere to hold it, so
 * a save from the rich-text view would drop it.
 */
const codeBlock = {
	content: 'text*',
	marks: '',
	group: 'block',
	code: true,
	defining: true,
	attrs: { params: { default: '' } },
	parseDOM: [
		{
			tag: 'pre',
			preserveWhitespace: 'full',
			getAttrs: (dom) => ({ params: dom.dataset.params ?? '' }),
		},
	],
	toDOM: (node) => [
		'pre',
		node.attrs.params ? { 'data-params': node.attrs.params } : {},
		['code', 0],
	],
} satisfies NodeSpec;

/**
 * Inline code is literal text: Markdown reads `**` inside backticks as two
 * asterisks, so bold, italic, and strikethrough cannot sit on code. A link
 * can.
 */
const code = {
	...basicMarks.code,
	excludes: 'strong em strike',
} satisfies MarkSpec;

export const noteSchema = new Schema({
	nodes: {
		doc: basicNodes.doc,
		paragraph: basicNodes.paragraph,
		blockquote: basicNodes.blockquote,
		horizontal_rule: basicNodes.horizontal_rule,
		heading: basicNodes.heading,
		code_block: codeBlock,
		text: basicNodes.text,
		hard_break: basicNodes.hard_break,
		taskList,
		taskItem,
		ordered_list: { ...orderedList, content: 'list_item+', group: 'block' },
		bullet_list: { ...bulletList, content: 'list_item+', group: 'block' },
		list_item: { ...listItem, content: 'paragraph block*' },
	},
	marks: { ...basicMarks, strike, code },
});
