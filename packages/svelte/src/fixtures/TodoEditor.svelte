<!-- A component that edits one todo of the module-scope folder, and hands its editor out. -->
<script lang="ts">
	import type { OpenFolderError } from '@epicenter/folder/core';
	import type { NoteEdit } from '../client.svelte.js';
	import { folder, type todos } from './app.test-support.js';

	type Edit = NoteEdit<(typeof todos)['collections']['todos'], OpenFolderError>;
	let { id, expose }: { id: string; expose: (edit: Edit) => void } = $props();
	// svelte-ignore state_referenced_locally
	const todo = folder.todos.edit({ id });
	// svelte-ignore state_referenced_locally
	expose(todo);
</script>

<p data-testid="title">{todo.fields.title}</p>
