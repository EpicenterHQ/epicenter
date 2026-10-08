<script lang="ts">
	import { buildCreateTable } from '@epicenter/matter-core';
	import * as Accordion from '@epicenter/ui/accordion';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Snippet } from '@epicenter/ui/snippet';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import Table2Icon from '@lucide/svelte/icons/table-2';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import type { VaultHandle } from '$lib/vault.svelte';

	// The "show the database" panel: the one honest surface that says matter IS a SQLite database. It
	// gives the db file path, a copyable `sqlite3` line to open it, and each typed table's CREATE TABLE
	// (the same DDL the projector emits), so a user or an agent can see exactly what SQL can query.
	let { vault }: { vault: VaultHandle } = $props();

	const dbPath = $derived(`${vault.root}/.matter/matter.sqlite`);
	const sqliteCommand = $derived(`sqlite3 "${dbPath}"`);

	// Each typed table's CREATE TABLE. An untyped folder has no projected table (no contract = no
	// columns), so it is skipped.
	const tableSchemas = $derived(
		vault.tables.flatMap((table) => {
			const view = table.read.view;
			if (view.mode !== 'typed') return [];
			return [
				{
					name: table.folderName,
					ddl: buildCreateTable(table.folderName, view.contract),
				},
			];
		}),
	);
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto w-full max-w-4xl space-y-8 p-4">
		<SectionHeader.Root>
			<SectionHeader.Title level={2}>SQLite projection</SectionHeader.Title>
			<SectionHeader.Description>
				Matter rebuilds this read-only database from the markdown in {vault.folderName}.
			</SectionHeader.Description>
		</SectionHeader.Root>

		<section class="space-y-3">
			<SectionHeader.Root>
				<SectionHeader.Title level={3}>Connect</SectionHeader.Title>
				<SectionHeader.Description>
					Copy the database path or open it with the SQLite CLI.
				</SectionHeader.Description>
			</SectionHeader.Root>
			<Item.Group class="gap-2!">
				<Item.Root variant="outline" size="sm">
					<Item.Media variant="icon"><DatabaseIcon /></Item.Media>
					<Item.Content class="min-w-0">
						<Item.Title>Database file</Item.Title>
						<Item.Description class="line-clamp-1 font-mono text-xs" title={dbPath}>
							{dbPath}
						</Item.Description>
					</Item.Content>
					<Item.Actions>
						<CopyButton
							text={dbPath}
							size="icon-sm"
							tabindex={0}
							aria-label="Copy database path"
						/>
					</Item.Actions>
				</Item.Root>
				<Item.Root variant="outline" size="sm">
					<Item.Media variant="icon"><TerminalIcon /></Item.Media>
					<Item.Content class="min-w-0">
						<Item.Title>Terminal command</Item.Title>
						<Item.Description
							class="line-clamp-1 font-mono text-xs"
							title={sqliteCommand}
						>
							{sqliteCommand}
						</Item.Description>
					</Item.Content>
					<Item.Actions>
						<CopyButton
							text={sqliteCommand}
							size="icon-sm"
							tabindex={0}
							aria-label="Copy terminal command"
						/>
					</Item.Actions>
				</Item.Root>
			</Item.Group>
		</section>

		<section class="space-y-3">
			<SectionHeader.Root>
				<SectionHeader.Title level={3}>Projected tables</SectionHeader.Title>
				<SectionHeader.Description>
					{tableSchemas.length === 0
						? 'No typed tables are available to SQL.'
						: `${tableSchemas.length} ${tableSchemas.length === 1 ? 'typed table is' : 'typed tables are'} available to SQL.`}
				</SectionHeader.Description>
			</SectionHeader.Root>
			{#if tableSchemas.length === 0}
				<Empty.Root class="min-h-48 border-0">
					<Empty.Media variant="icon"><Table2Icon /></Empty.Media>
					<Empty.Title>No projected tables</Empty.Title>
					<Empty.Description>
						Add a matter.json with typed fields to project a table.
					</Empty.Description>
				</Empty.Root>
			{:else}
				<Accordion.Root type="multiple">
					{#each tableSchemas as schema (schema.name)}
						<Accordion.Item value={schema.name}>
							<Accordion.Trigger>
								<span class="flex items-center gap-2 font-mono text-sm">
									<Table2Icon class="size-4 text-muted-foreground" />
									{schema.name}
								</span>
							</Accordion.Trigger>
							<Accordion.Content class="pb-4">
								<Snippet
									text={schema.ddl}
									copyLabel="Copy {schema.name} schema"
								/>
							</Accordion.Content>
						</Accordion.Item>
					{/each}
				</Accordion.Root>
			{/if}
		</section>
	</div>
</div>
