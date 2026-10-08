<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import * as Sheet from '@epicenter/ui/sheet';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import {
		describeExpected,
		formatExpected,
		summarize,
		toViolations,
		type VaultIntegrity,
		type Violation,
	} from '@epicenter/matter-core';

	// The one "what is wrong" sheet for the whole vault, a pure selector over the live
	// VaultIntegrity. It re-decides nothing: `toViolations` and `summarize` read the same vault
	// assessment the grid renders, so the panel and the grid can never disagree.
	let { integrity }: { integrity: VaultIntegrity } = $props();

	const summary = $derived(summarize(integrity));
	const violations = $derived(toViolations(integrity));

	// Tables that could not load at all: not violations (they have no cells), surfaced on their own.
	const fatals = $derived(
		summary.tables.filter(
			(table) =>
				table.status === 'unreadable' || table.status === 'invalid-contract',
		),
	);

	const unreadableFiles = $derived(summary.unreadableFiles);
	const issueCount = $derived(
		violations.length + fatals.length + unreadableFiles.length,
	);
	const clean = $derived(issueCount === 0);

	/** One human line per violation, expected computed at the edge for an invalid value. */
	function describe(violation: Violation): string {
		switch (violation.kind) {
			case 'missing-target':
				return `${violation.table}.${violation.field} → ${violation.target}: table not in this vault`;
			case 'missing-required':
				return `${violation.table}/${violation.row}: ${violation.field} needs a value`;
			case 'invalid-type':
				return `${violation.table}/${violation.row}: ${violation.field} is invalid (expected ${formatExpected(describeExpected(violation.field))})`;
			case 'dangling-reference':
				return `${violation.table}/${violation.row}: ${violation.field} → "${violation.value}" is not a row in ${violation.target}`;
		}
	}
</script>

<Sheet.Root>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button
				variant={clean ? 'ghost' : 'outline'}
				size="xs"
				aria-label={clean ? 'Vault integrity is clean' : `Open ${issueCount} integrity issues`}
				{...props}
			>
				{#if clean}
					<CircleCheckIcon class="text-emerald-600 dark:text-emerald-400" />
					<span class="hidden sm:inline">Integrity</span>
				{:else}
					<TriangleAlertIcon class="text-amber-600 dark:text-amber-400" />
					<span class="hidden sm:inline">Integrity</span>
					<Badge variant="secondary">{issueCount}</Badge>
				{/if}
			</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content class="flex flex-col gap-0 p-0">
		<Sheet.Header class="border-b px-5 py-4 text-left">
			<Sheet.Title>Vault integrity</Sheet.Title>
			<Sheet.Description>
				{summary.totals.ready} ready across {summary.totals.tables}
				{summary.totals.tables === 1 ? 'table' : 'tables'}
			</Sheet.Description>
		</Sheet.Header>

		<div class="min-h-0 flex-1 overflow-y-auto p-3">
			{#if clean}
				<Empty.Root class="min-h-full border-0">
					<Empty.Media variant="icon"><CircleCheckIcon /></Empty.Media>
					<Empty.Title>Everything resolves</Empty.Title>
					<Empty.Description>
						Every readable row matches its contract and all references resolve.
					</Empty.Description>
				</Empty.Root>
			{:else}
				<Item.Group>
					{#each fatals as table (table.name)}
						<Item.Root variant="outline" size="sm" role="listitem">
							<Item.Content>
								<Item.Title class="font-mono text-destructive">{table.name}</Item.Title>
								<Item.Description class="line-clamp-none">
									{table.status === 'unreadable' ? "Can't read table" : 'Invalid contract'}:
									{'message' in table ? table.message : ''}
								</Item.Description>
							</Item.Content>
						</Item.Root>
					{/each}
					{#each unreadableFiles as file (`${file.table}/${file.fileName}`)}
						<Item.Root variant="outline" size="sm" role="listitem">
							<Item.Content>
								<Item.Title class="font-mono text-destructive">
									{file.table}/{file.fileName}
								</Item.Title>
								<Item.Description class="line-clamp-none">
									Can't read: {file.message}
								</Item.Description>
							</Item.Content>
						</Item.Root>
					{/each}
					{#each violations as violation, index (index)}
						<Item.Root variant="outline" size="sm" role="listitem">
							<Item.Content>
								<Item.Title
									class={violation.kind === 'missing-target'
										? 'text-amber-700 dark:text-amber-400'
										: 'text-destructive'}
								>
									{violation.kind.replaceAll('-', ' ')}
								</Item.Title>
								<Item.Description class="line-clamp-none font-mono text-xs">
									{describe(violation)}
								</Item.Description>
							</Item.Content>
						</Item.Root>
					{/each}
				</Item.Group>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
