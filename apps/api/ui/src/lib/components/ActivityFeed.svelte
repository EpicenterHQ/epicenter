<script lang="ts">
	import { providerLabel } from '@epicenter/constants/ai-providers';
	import * as Empty from '@epicenter/ui/empty';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing } = getDashboard();

	const events = createQuery(() => billing.events({ limit: 50 }).options);

	function formatTimestamp(ms: number): string {
		return new Date(ms).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
		});
	}
</script>

{#if events.isPending}
	<div class="space-y-2">
		{#each Array(10) as _}
			<Skeleton class="h-8 w-full" />
		{/each}
	</div>
{:else if events.isError}
	<Empty.Root class="py-8 border-0" role="alert">
		<Empty.Header>
			<Empty.Title class="text-destructive">Failed to load activity</Empty.Title>
		</Empty.Header>
	</Empty.Root>
{:else if !events.data?.events.length}
	<Empty.Root class="py-8 border-0">
		<Empty.Header>
			<Empty.Title>No activity yet</Empty.Title>
		</Empty.Header>
	</Empty.Root>
{:else}
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Time</Table.Head>
				<Table.Head>Model</Table.Head>
				<Table.Head>Provider</Table.Head>
				<Table.Head class="text-right">Credits</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each events.data.events as event (event.id)}
				<Table.Row>
					<Table.Cell class="text-xs text-muted-foreground whitespace-nowrap">
						{formatTimestamp(event.timestampMs)}
					</Table.Cell>
					<Table.Cell class="font-mono text-xs"
						>{event.model ?? '-'}</Table.Cell
					>
					<Table.Cell class="text-xs text-muted-foreground">
						{event.provider ? providerLabel(event.provider) : '-'}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{event.credits}
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
{/if}
