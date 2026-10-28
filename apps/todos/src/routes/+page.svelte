<script lang="ts">
	import { openBrowserRepository } from '@epicenter/repository/browser';
	import { todosApp } from '$lib/definition.js';
	import OpenTodos from './local/OpenTodos.svelte';

	/**
	 * The server to sync with, set at build time, such as
	 * `ws://127.0.0.1:8787/?user=me` from `bun packages/repository/scripts/serve.ts`.
	 * Without one, Todos keeps its todos on this device.
	 */
	const server: string | undefined = import.meta.env.VITE_TODOS_SERVER || undefined;
</script>

<OpenTodos
	open={() => openBrowserRepository({ app: todosApp, name: 'todos', server: server === undefined ? undefined : { url: server } })}
	syncsTo={server}
/>
