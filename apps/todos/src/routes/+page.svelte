<!--
	Chooses the storage before opening any (`chooseStorage`): this browser's
	local folder, or the declared folder of the desktop build and of a browser
	that still holds an earlier build's todos. When the check fails, nothing
	opens: an empty list would look as if those todos were lost.
-->
<script lang="ts">
	import LocalFolderApp from '@epicenter/svelte/local-folder-app';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { todosTables } from '$lib/definition.js';
	import { chooseStorage } from '$lib/storage-choice.js';
	import TodosView from './local/TodosView.svelte';

	let choosing = $state(chooseStorage());
</script>

{#await choosing}
	<Loading class="h-dvh" label="Opening Todos…" />
{:then choice}
	{#if choice.storage === 'local'}
		<LocalFolderApp title="Todos" tables={todosTables}><TodosView /></LocalFolderApp>
	{:else if choice.storage === 'legacy'}
		{#await import('./components/LegacyTodos.svelte')}
			<Loading class="h-dvh" label="Opening Todos…" />
		{:then { default: LegacyTodos }}
			<LegacyTodos />
		{:catch error}
			<Empty.Root class="h-dvh">
				<Empty.Title>Todos could not load</Empty.Title>
				<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button>
			</Empty.Root>
		{/await}
	{:else}
		<Empty.Root class="h-dvh">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Header>
				<Empty.Title>Todos could not check this browser for your todos</Empty.Title>
				<Empty.Description role="alert">
					An earlier version of Todos may have kept todos here, so Todos opens nothing until it can check. {choice.reason}
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" size="sm" onclick={() => (choosing = chooseStorage())}>Try again</Button>
			</Empty.Content>
		</Empty.Root>
	{/if}
{/await}
