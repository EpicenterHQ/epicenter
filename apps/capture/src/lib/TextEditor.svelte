<script lang="ts">
  import { configureYProsemirror, redo, syncPlugin, undo, yUndoPlugin } from '@y/prosemirror';
  import * as Y from '@y/y';
  import { keymap } from 'prosemirror-keymap';
  import { Schema } from 'prosemirror-model';
  import { EditorState, type Command } from 'prosemirror-state';
  import { EditorView } from 'prosemirror-view';
  import 'prosemirror-view/style/prosemirror.css';
  import { onMount } from 'svelte';

  // Capture bodies are flat Y.Node text. Code semantics make the clipboard
  // plain text and preserve line breaks without changing the stored shape.
  const schema = new Schema({
    nodes: {
      doc: { content: 'text*', code: true },
      text: {},
    },
    marks: {},
  });

  let { body, label }: { body: Y.Node; label: string } = $props();
  let element: HTMLDivElement;
  const insertNewline: Command = (state, dispatch) => {
    dispatch?.(state.tr.insertText('\n'));
    return true;
  };

  onMount(() => {
    const undoManager = new Y.UndoManager(body, { trackedOrigins: new Set() });
    const view = new EditorView(element, {
      state: EditorState.create({
        schema,
        plugins: [
          syncPlugin(),
          yUndoPlugin(undoManager),
          keymap({
            'Mod-z': undo,
            'Mod-y': redo,
            'Mod-Shift-z': redo,
            Enter: insertNewline,
            'Shift-Enter': insertNewline,
          }),
        ],
      }),
      attributes: {
        class: 'capture-text-editor min-h-28 w-full rounded-lg border border-border bg-transparent p-4 text-base leading-relaxed outline-none focus:border-foreground',
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
      },
    });
    configureYProsemirror({ ytype: body })(view.state, view.dispatch);

    return () => {
      view.destroy();
      undoManager.destroy();
    };
  });
</script>

<div bind:this={element}></div>

<style>
  :global(.capture-text-editor.ProseMirror) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
