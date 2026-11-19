<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>{page.status === 404 ? 'Page Not Found' : 'Error'} - Whispering</title>
</svelte:head>

<Empty.Root class="flex-1 p-8">
	<Empty.Header>
		<Empty.Title class="text-4xl font-bold text-foreground">
			{#if page.status === 404}
				404 - Page Not Found
			{:else}
				Something Went Wrong
			{/if}
		</Empty.Title>
		<Empty.Description class="text-lg">
			{#if page.status === 404}
				The page you're looking for doesn't exist.
			{:else}
				An unexpected error occurred.
			{/if}
		</Empty.Description>
	</Empty.Header>
	<Empty.Content> <Button href={resolve('/')}>Go Home</Button> </Empty.Content>
</Empty.Root>
