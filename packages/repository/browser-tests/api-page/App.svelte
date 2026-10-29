<!--
	The test page's app: a list of todos kept in memory, each with a toggle,
	and the selected todo's body in the repository's source editor. It is
	mounted once per page load; the repository beneath it comes and goes.
-->
<script lang="ts">
	import type { Editor, Repository } from '../../src/api/index.js';
	import SourceEditor from '../../../svelte/src/repository/source-editor.svelte';
	import { onMount } from 'svelte';
	import type { todosApp } from './app.js';

	let { repo, onEditor }: { repo: Repository<(typeof todosApp)['definitions']>; onEditor: (editor: Editor | undefined) => void } = $props();
	let editor = $state.raw<Editor>();
	let opening = $state('');

	onMount(() => {
		(globalThis as { mounts?: number }).mounts = ((globalThis as { mounts?: number }).mounts ?? 0) + 1;
	});

	async function select(stem: string) {
		opening = stem;
		const opened = await repo.todos.openEditor({ stem });
		if (opened.error !== null) return;
		editor = opened.data;
		onEditor(editor);
	}
</script>

<p data-testid="status">{repo.status().status}</p>
<ul>
	{#each repo.todos.all() as todo (todo.path)}
		<li data-testid="todo" data-stem={todo.params.stem}>
			<input type="checkbox" checked={todo.valid && todo.fields.done} onchange={() => void repo.todos.patch(todo.params, { done: !(todo.valid && todo.fields.done) })} />
			<button type="button" onclick={() => void select(todo.params.stem)}>{todo.fields.title}</button>
			<span data-testid="body">{todo.body}</span>
		</li>
	{/each}
</ul>
{#if editor !== undefined}
	{#key editor}
		<SourceEditor {editor} shows="body" label={`Editing ${opening}`} />
	{/key}
{/if}
