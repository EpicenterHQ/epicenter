<script lang="ts">
	import {
		defaultKeymap,
		history,
		historyKeymap,
		indentWithTab,
	} from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import {
		defaultHighlightStyle,
		syntaxHighlighting,
	} from '@codemirror/language';
	import { EditorState } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import type * as Y from '@y/y';

	// The markdown content node itself, rather than a separate row document. The
	// caller already chose which table and which row; handing that choice down
	// would make this component know about Skills, and it only knows about text.
	let { content }: { content: Y.Node } =
		$props();
	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!container) return;
		let applyingDocumentUpdate = false;
		const view = new EditorView({
			state: EditorState.create({
				doc: content.toString(),
				extensions: [
					history(),
					keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					syntaxHighlighting(defaultHighlightStyle),
					markdown(),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !applyingDocumentUpdate) {
							const next = update.state.doc.toString();
							// One delta rather than a delete followed by an insert:
							// `applyDelta` opens its own transaction, so two calls would
							// publish an empty document to every peer in between.
							content.applyDelta(
								content.change.delete(content.length).insert(next) as never,
							);
						}
					}),
					placeholder('Write skill instructions here...'),
					EditorView.theme({
						'&': { height: '100%', fontSize: '14px' },
						'.cm-scroller': {
							fontFamily:
								'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
							padding: '1rem',
							overflow: 'auto',
						},
						'.cm-content': { caretColor: 'var(--foreground, currentColor)' },
						'.cm-focused': { outline: 'none' },
						'.cm-gutters': { display: 'none' },
						'.cm-activeLine': { backgroundColor: 'transparent' },
					}),
				],
			}),
			parent: container,
		});
		const onDocumentUpdate = () => {
			const next = content.toString();
			if (next === view.state.doc.toString()) return;
			applyingDocumentUpdate = true;
			try {
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: next },
				});
			} finally {
				applyingDocumentUpdate = false;
			}
		};
		content.observe(onDocumentUpdate);
		return () => {
			content.unobserve(onDocumentUpdate);
			view.destroy();
		};
	});
</script>

<div class="h-full w-full overflow-hidden bg-transparent" bind:this={container}></div>
