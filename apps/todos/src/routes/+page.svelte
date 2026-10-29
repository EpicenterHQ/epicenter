<!--
	Todos over one of this browser's repositories, chosen in the repository
	chooser: kept only on this device, or synced with a server.
-->
<script lang="ts">
	import RepositoryChooser from '@epicenter/svelte/repository/chooser';
	import { todosApp } from '$lib/definition.js';
	import TodosApp from './local/TodosApp.svelte';
</script>

<RepositoryChooser app={todosApp} name="Todos">
	{#snippet children({ repo, manifest, leave })}
		<TodosApp {repo} repository={manifest.name} syncsTo={manifest.url ?? undefined} onLeave={leave} />
	{/snippet}
</RepositoryChooser>
