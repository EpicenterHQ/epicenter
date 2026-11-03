<!--
	A page that did not load. When its world did not open (`StartupFailed`),
	the build's recovery screen (`#platform/recovery`) offers the fix: sign-in
	on the web, the data folder's remedies on the desktop. It imports nothing
	of the world, which is why it can show it failing.
-->
<script lang="ts">
	import Recovery from '#platform/recovery';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { page } from '$app/state';
</script>

{#if page.error?.startup}
	<Recovery failure={page.error.startup} />
{:else}
	<Empty.Root class="h-dvh">
		<Empty.Title>Todos could not show this page</Empty.Title>
		<Empty.Description>{page.status}: {page.error?.message}</Empty.Description>
		<Button size="sm" variant="outline" onclick={() => location.reload()}>Reload</Button>
	</Empty.Root>
{/if}
