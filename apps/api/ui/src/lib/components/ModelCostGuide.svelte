<script lang="ts">
	import { AI_MODELS, providerLabel } from '@epicenter/ai/providers';
	import * as Table from '@epicenter/ui/table';

	// The catalog is a compile-time constant, so the table never pends or
	// errors. Mirror the order the server used to send: credits ascending,
	// then model id.
	const rows = AI_MODELS.map((entry) => ({
		model: entry.id,
		provider: entry.provider,
		credits: entry.credits,
	})).sort((a, b) => a.credits - b.credits || a.model.localeCompare(b.model));
</script>

<Table.Root>
	<Table.Header>
		<Table.Row>
			<Table.Head>Model</Table.Head>
			<Table.Head>Provider</Table.Head>
			<Table.Head class="text-right">Credits/call</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#each rows as row (row.model)}
			<Table.Row>
				<Table.Cell class="font-mono text-xs">{row.model}</Table.Cell>
				<Table.Cell class="text-muted-foreground text-xs">
					{providerLabel(row.provider)}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{row.credits}</Table.Cell>
			</Table.Row>
		{/each}
	</Table.Body>
</Table.Root>
