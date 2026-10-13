<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Empty from '@epicenter/ui/empty';
	import { start } from '#platform/start';

	const GitHubReturn = start?.GitHubReturn;
	// The address GitHub returned to, read once: the handoff code is used once.
	const url = new URL(page.url);
</script>

{#if GitHubReturn}
	<GitHubReturn {url} onfinished={() => void goto(resolve('/'), { replaceState: true })} />
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>GitHub sync is not part of this build</Empty.Title>
		<Empty.Description>Todos inside Epicenter keeps its folder on this computer.</Empty.Description>
	</Empty.Root>
{/if}
