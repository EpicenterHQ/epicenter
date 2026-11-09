<!-- A component that edits one todo of the module-scope folder through bound inputs, and hands its editor out. -->
<script lang="ts">
	import type { NoteEdit } from '@epicenter/folder/core';
	import { folder, type todos } from './app.test-support.js';

	type Edit = NoteEdit<(typeof todos)['collections']['todos']>;
	let { id, expose }: { id: string; expose: (edit: Edit) => void } = $props();
	// svelte-ignore state_referenced_locally
	const todo = folder.todos.edit({ id });
	// svelte-ignore state_referenced_locally
	expose(todo);
</script>

<p data-testid="title">{todo.fields.title}</p>
<input data-testid="title-input" bind:value={todo.fields.title} />
<input data-testid="done-input" type="checkbox" bind:checked={todo.fields.done} />
{#if todo.saving()}<p data-testid="saving">saving</p>{/if}
