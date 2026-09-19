<script lang="ts">
	import type { QueryResult, QueryValue } from '@epicenter/device';
	import { fromData } from '@epicenter/svelte';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import { onDestroy, untrack } from 'svelte';
	import type { MailData } from '$lib/data';
	import { mail } from '$lib/mail';

	let {
		data,
		account,
	}: { data: MailData; account: string | null } = $props();
	const library = fromData(untrack(() => data));
	const queries = library.tables.savedQueries;
	let selected = $state<string | null>(null);
	let name = $state('');
	let sql = $state('');
	let baseline = $state.raw({ name: '', sql: '', fingerprint: '' });
	let saving = $state(false);
	let unsavedWrite = $state(false);
	let failure = $state('');
	let notice = $state('');
	let destination = $state<{ id: string | null } | null>(null);
	let deleting = $state(false);
	let running = $state(false);
	let queryFailure = $state('');
	let result = $state.raw<{
		sql: string;
		account: string;
		value: QueryResult;
	} | null>(null);
	let execution: AbortController | undefined;
	let alive = true;
	const dirty = $derived(
		name !== baseline.name || sql !== baseline.sql || unsavedWrite,
	);
	const current = $derived(
		selected === null ? undefined : queries.get(selected),
	);
	const malformed = $derived(
		queries.nonconforming.find((row) => row.id === selected),
	);
	const fingerprint = $derived(
		current
			? JSON.stringify([current.name, current.sql])
			: malformed
				? JSON.stringify(malformed.raw)
				: '',
	);
	const conflict = $derived(
		selected !== null && fingerprint !== baseline.fingerprint,
	);
	const persistence = $derived(library.persistence.get());

	function open(id: string | null) {
		const row = id === null ? undefined : queries.get(id);
		const broken = queries.nonconforming.find((row) => row.id === id);
		selected = row || broken ? id : null;
		name =
			row?.name ??
			(typeof broken?.raw.name === 'string' ? broken.raw.name : '');
		sql =
			row?.sql ?? (typeof broken?.raw.sql === 'string' ? broken.raw.sql : '');
		baseline = {
			name,
			sql,
			fingerprint: row
				? JSON.stringify([row.name, row.sql])
				: broken
					? JSON.stringify(broken.raw)
					: '',
		};
		failure = '';
		notice = '';
		clearExecution();
	}

	function navigate(id: string | null) {
		if (dirty) destination = { id };
		else open(id);
	}

	function cancelDiscard() {
		destination = null;
	}

	function discardDraft() {
		if (destination) open(destination.id);
		destination = null;
	}

	async function persist() {
		await library.persistence.flush();
		if (library.persistence.get() !== 'saved')
			throw new Error(
				'Could not save to this device. Keep this window open and retry.',
			);
		unsavedWrite = false;
	}

	async function save(asNew = false) {
		if (saving || (conflict && !asNew)) return;
		saving = true;
		failure = '';
		notice = '';
		try {
			if (selected === null || asNew)
				selected = queries.create({ name, sql }).id;
			else {
				const { error } = queries.update(selected, { name, sql });
				if (error) throw new Error(error.message);
			}
			unsavedWrite = true;
			baseline = { name, sql, fingerprint: JSON.stringify([name, sql]) };
			await persist();
			notice = 'Saved to this device.';
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function retryPersistence() {
		saving = true;
		failure = '';
		try {
			await persist();
			notice = 'Saved to this device.';
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (selected === null) return;
		saving = true;
		failure = '';
		try {
			queries.delete(selected);
			unsavedWrite = true;
			open(null);
			deleting = false;
			await persist();
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			deleting = false;
		} finally {
			saving = false;
		}
	}

	function clearExecution() {
		execution?.abort();
		execution = undefined;
		running = false;
		result = null;
		queryFailure = '';
	}

	$effect(() => {
		account;
		untrack(clearExecution);
	});
	onDestroy(() => {
		alive = false;
		execution?.abort();
	});

	async function run() {
		if (account === null) return;
		clearExecution();
		const controller = new AbortController();
		execution = controller;
		const captured = { sql, account };
		running = true;
		try {
			const value = await mail.query(
				captured.account,
				captured.sql,
				controller.signal,
			);
			if (alive && execution === controller && account === captured.account)
				result = { ...captured, value };
		} catch (error) {
			if (alive && execution === controller && account === captured.account)
				queryFailure = error instanceof Error ? error.message : String(error);
		} finally {
			if (alive && execution === controller) {
				running = false;
				execution = undefined;
			}
		}
	}

	function text(value: QueryValue) {
		if (value === null) return 'NULL';
		if (typeof value === 'object')
			return 'integer' in value ? value.integer : `hex:${value.blob}`;
		return String(value);
	}
</script>

<svelte:window
	onbeforeunload={(event) => {
		if (dirty || saving || persistence !== 'saved') {
			event.preventDefault();
			event.returnValue = '';
		}
	}}
/>

<section
	aria-label="Saved queries"
	class="grid min-h-0 flex-1 overflow-auto md:grid-cols-[16rem_minmax(0,1fr)]"
>
	<aside class="flex flex-col gap-2 border-b p-4 md:border-r md:border-b-0">
		<h2 class="font-semibold">Saved queries</h2>
		<Button variant="outline" disabled={saving} onclick={() => navigate(null)}>
			New query
		</Button>
		{#each queries.rows as row (row.id)}
			<Button
				variant={selected === row.id ? 'secondary' : 'ghost'}
				class="justify-start truncate"
				disabled={saving}
				onclick={() => navigate(row.id)}
			>
				{row.name || 'Untitled query'}
			</Button>
		{/each}
		{#each queries.nonconforming as row (row.id)}
			<Button
				variant={selected === row.id ? 'secondary' : 'ghost'}
				disabled={saving}
				onclick={() => navigate(row.id)}
			>
				Repair query {row.id.slice(0, 8)}
			</Button>
		{/each}
		{#if queries.rows.length === 0 && queries.nonconforming.length === 0}
			<p class="text-sm text-muted-foreground">
				Save a query to run it again later.
			</p>
		{/if}
	</aside>
	<div class="flex min-w-0 flex-col gap-4 p-4">
		<p class="text-sm text-muted-foreground">
			Query downloaded Gmail facts in messages and labels. Pending triage changes are not included. Saving stores the
			text; only Run executes it.
		</p>
		{#if conflict}
			<Alert.Root>
				<Alert.Title>
					This query changed elsewhere
				</Alert.Title><Alert.Description>
					Your draft is preserved. Reload the stored version or save your draft
					as a new query.
				</Alert.Description>
				<div class="mt-2 flex gap-2">
					<Button
						variant="outline"
						disabled={saving}
						onclick={() => {
							if (dirty) destination = { id: selected };
							else open(selected);
						}}
					>
						Reload stored version
					</Button><Button disabled={saving} onclick={() => save(true)}>
						Save as new query
					</Button>
				</div>
			</Alert.Root>
		{/if}
		{#if malformed}
			<Alert.Root>
				<Alert.Title>This query needs repair</Alert.Title><Alert.Description>
					Correct the name and SQL fields and Save, or Delete this query. {malformed.issues
						.map((issue) => issue.message)
						.join(' ')}
				</Alert.Description>
			</Alert.Root>
		{/if}
		{#if failure || persistence === 'blocked'}
			<Alert.Root variant="destructive">
				<Alert.Title>
					Could not save query changes
				</Alert.Title><Alert.Description>
					{failure || 'Keep this window open and retry saving.'}
				</Alert.Description>
				{#if unsavedWrite || persistence !== 'saved'}
					<Button
						class="mt-2"
						variant="outline"
						disabled={saving}
						onclick={retryPersistence}
					>
						Retry saving
					</Button>
				{/if}
			</Alert.Root>
		{/if}
		<div class="grid gap-2">
			<Label for="query-name">Name</Label><Input
				id="query-name"
				bind:value={name}
				disabled={saving}
			/>
		</div>
		<div class="grid gap-2">
			<Label for="query-sql">SQL</Label><Textarea
				id="query-sql"
				class="min-h-48 font-mono"
				bind:value={sql}
				disabled={saving}
				spellcheck={false}
			/>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button onclick={() => save()} disabled={saving || conflict}>
				{#if saving}<Spinner />{/if}Save
			</Button>
			<Button
				variant="outline"
				onclick={run}
				disabled={running || account === null || sql.trim() === ''}
			>
				{#if running}<Spinner />{/if}Run
			</Button>
			{#if running}<Button variant="ghost" onclick={clearExecution}>
					Cancel run
				</Button>{/if}
			{#if selected !== null}<Button
					variant="ghost"
					disabled={saving}
					onclick={() => {
						deleting = true;
					}}
				>
					Delete
				</Button>{/if}
			<span role="status" class="text-sm text-muted-foreground">
				{dirty ? 'Unsaved changes' : notice}
			</span>
		</div>
		{#if account === null}<p class="text-sm text-muted-foreground">
				Select a Gmail account to run this query.
			</p>{/if}
		{#if queryFailure}<Alert.Root variant="destructive">
				<Alert.Title>Query failed</Alert.Title><Alert.Description>
					{queryFailure}
				</Alert.Description>
			</Alert.Root>{/if}
		{#if result && result.account === account}
			<div class="min-w-0 space-y-2" aria-label="Query results">
				<h3 class="font-semibold">Results: {result.value.rows.length} {result.value.rows.length === 1 ? 'row' : 'rows'}</h3>
				<pre
					class="overflow-x-auto text-xs text-muted-foreground">{result.sql}</pre>
				{#if result.value.truncated}<p role="status" class="text-sm">
						Results reached the query limit. Narrow your query to see more.
					</p>{/if}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							{#each result.value.columns as column, index (index)}<Table.Head>
									{column || '(unnamed)'}
								</Table.Head>{/each}
						</Table.Row>
					</Table.Header><Table.Body>
						{#each result.value.rows as row, index (index)}<Table.Row>
								{#each row as value, position (position)}<Table.Cell
										class="max-w-96 whitespace-pre-wrap break-words font-mono"
									>
										{text(value)}
									</Table.Cell>{/each}
							</Table.Row>{/each}
					</Table.Body>
				</Table.Root>
				{#if result.value.rows.length === 0}<Empty.Root>
						<Empty.Header>
							<Empty.Title>No matching rows</Empty.Title><Empty.Description>
								The column names above come from the query.
							</Empty.Description>
						</Empty.Header>
					</Empty.Root>{/if}
			</div>
		{/if}
	</div>
</section>

<Dialog.Root
	open={destination !== null}
	onOpenChange={(open) => {
		if (!open) cancelDiscard();
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Discard this draft?</Dialog.Title><Dialog.Description>
				Your unsaved text will be lost. Cancel to save it first.
			</Dialog.Description>
		</Dialog.Header><Dialog.Footer>
			<Button variant="outline" onclick={cancelDiscard}>Cancel</Button><Button
				variant="destructive"
				onclick={discardDraft}
			>
				Discard draft
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
<Dialog.Root
	open={deleting}
	onOpenChange={(open) => {
		if (!saving) deleting = open;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete this saved query?</Dialog.Title><Dialog.Description>
				This also discards any edits in the editor. Downloaded mail is
				unchanged.
			</Dialog.Description>
		</Dialog.Header><Dialog.Footer>
			<Button
				variant="outline"
				disabled={saving}
				onclick={() => {
					deleting = false;
				}}
			>
				Cancel
			</Button><Button variant="destructive" disabled={saving} onclick={remove}>
				Delete query
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
