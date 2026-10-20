<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Table from '@epicenter/ui/table';
	import * as Alert from '@epicenter/ui/alert';
	import { commands } from '../ui/bindings.gen';

	import type { Views } from './views.svelte';
	let { views, viewKey }: { views: Views; viewKey: string } = $props();
	const recipe = $derived(views.value(viewKey));
	const sql = $derived(recipe?.type === 'sql' ? recipe.sql : '');
	const execution = $derived(views.execution(viewKey));
	const answer = $derived(execution?.answer);
	const error = $derived(execution?.error);
	const running = $derived(execution?.running ?? false);
	function change(value: string) {
		if (recipe?.type === 'sql') views.edit(viewKey, { ...recipe, sql: value });
	}
</script>

<section
	class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
	aria-label="SQL console"
>
	<p class="text-sm text-muted-foreground">
		Query saved Markdown with documents(path, directory, stem, fields, body,
		issues). Fields and issues are JSON. Queries read saved files and leave
		unfinished typing alone.
	</p>
	<Textarea
		aria-label="SQL statement"
		bind:value={() => sql, (value) => change(String(value))}
		class="font-mono"
		spellcheck="false"
	/>
	<div>
		<Button
			onclick={() => void views.run(viewKey, commands.folderQuery)}
			disabled={running}>{running ? 'Running…' : 'Run SQL'}</Button
		>
	</div>
	{#if execution && execution.sql !== sql}<p
			class="text-sm text-muted-foreground"
		>
			Results are from the previous statement.
		</p>{/if}
	{#if error}<Alert.Root variant="destructive"
			><Alert.Description>{error}</Alert.Description></Alert.Root
		>{/if}
	{#if answer}
		{#each answer.warnings as warning}<p class="text-sm text-destructive">
				Could not use the declared schemas: {warning}
			</p>{/each}
		{#if answer.truncated}<p class="text-sm text-muted-foreground">
				Results stopped at 1,000 rows or 4 MiB. Narrow the query or add LIMIT.
			</p>{/if}
		{#if answer.excluded.length}<p class="text-sm text-destructive">
				Could not read: {answer.excluded.join(', ')}
			</p>{/if}
		<p role="status" class="text-sm text-muted-foreground">
			{answer.rows.length} rows
		</p>
		<Table.Root
			><Table.Header
				><Table.Row
					>{#each answer.columns as column}<Table.Head>{column}</Table.Head
						>{/each}</Table.Row
				></Table.Header
			>
			<Table.Body
				>{#each answer.rows as row}<Table.Row
						>{#each answer.columns as column}<Table.Cell
								class="max-w-96 whitespace-pre-wrap break-words"
								>{row[column] == null
									? ''
									: typeof row[column] === 'object'
										? JSON.stringify(row[column])
										: String(row[column])}</Table.Cell
							>{/each}</Table.Row
					>{/each}</Table.Body
			>
		</Table.Root>
	{/if}
</section>
