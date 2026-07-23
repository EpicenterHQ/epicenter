<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import * as Sheet from '@epicenter/ui/sheet';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import {
		HOME_SNAPSHOT_CAPTURE_ROUTE,
		homeSnapshotQueryPath,
	} from '../routes.ts';
	import type {
		HomeSnapshot,
		HomeSnapshotLens,
		HomeSnapshotQueryResult,
	} from '../snapshot-query.ts';

	const lensOptions = [
		{ value: 'raw', label: 'Raw records' },
		{ value: 'chat', label: 'Chat' },
		{ value: 'honeycrisp', label: 'Honeycrisp' },
		{ value: 'whispering', label: 'Whispering' },
	] as const satisfies readonly {
		value: HomeSnapshotLens;
		label: string;
	}[];

	let lens = $state<HomeSnapshotLens>('raw');
	let snapshot = $state.raw<HomeSnapshot>();
	let sql = $state(
		'SELECT namespace, collection, record_key, payload_json\nFROM _epicenter_records\nLIMIT 100',
	);
	let result = $state.raw<HomeSnapshotQueryResult>();
	let error = $state<string>();
	let isCapturing = $state(false);
	let isQuerying = $state(false);
	let operationGeneration = 0;
	const isBusy = $derived(isCapturing || isQuerying);
	const columns = $derived(
		result?.rows[0] === undefined ? [] : Object.keys(result.rows[0]),
	);

	async function responseBody(response: Response): Promise<unknown> {
		const contentType = response.headers.get('content-type');
		return contentType?.includes('application/json')
			? response.json()
			: response.text();
	}

	function errorMessage(value: unknown): string {
		if (
			typeof value === 'object' &&
			value !== null &&
			'error' in value &&
			typeof value.error === 'object' &&
			value.error !== null &&
			'message' in value.error &&
			typeof value.error.message === 'string'
		) {
			return value.error.message;
		}
		return typeof value === 'string' && value !== ''
			? value
			: 'The snapshot operation failed.';
	}

	/** Capture replaces the active stale artifact and clears its prior query. */
	async function capture(): Promise<void> {
		if (isBusy) return;
		const generation = ++operationGeneration;
		const capturedLens = lens;
		isCapturing = true;
		error = undefined;
		try {
			const response = await fetch(HOME_SNAPSHOT_CAPTURE_ROUTE.pattern, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lens: capturedLens }),
			});
			const body = await responseBody(response);
			if (!response.ok) throw new Error(errorMessage(body));
			if (generation !== operationGeneration) return;
			snapshot = body as HomeSnapshot;
			result = undefined;
		} catch (cause) {
			if (generation !== operationGeneration) return;
			error = cause instanceof Error ? cause.message : 'Snapshot capture failed.';
		} finally {
			if (generation === operationGeneration) isCapturing = false;
		}
	}

	/** The button and Cmd/Ctrl+Enter shortcut share one bounded query command. */
	async function query(): Promise<void> {
		if (snapshot === undefined || sql.trim() === '' || isBusy) return;
		const snapshotId = snapshot.id;
		const generation = ++operationGeneration;
		isQuerying = true;
		error = undefined;
		try {
			const response = await fetch(homeSnapshotQueryPath(snapshotId), {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sql }),
			});
			const body = await responseBody(response);
			if (!response.ok) throw new Error(errorMessage(body));
			if (
				generation !== operationGeneration ||
				snapshot?.id !== snapshotId
			)
				return;
			result = body as HomeSnapshotQueryResult;
		} catch (cause) {
			if (generation !== operationGeneration) return;
			error = cause instanceof Error ? cause.message : 'Snapshot query failed.';
		} finally {
			if (generation === operationGeneration) isQuerying = false;
		}
	}

	function cell(value: string | number | null): string {
		return value === null ? '' : String(value);
	}
</script>

<Sheet.Root>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm">Snapshot</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content class="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
		<Sheet.Header class="border-b px-5 py-4 text-left">
			<Sheet.Title>Data snapshot</Sheet.Title>
			<Sheet.Description>
				Capture a coherent SQLite artifact, then query that inert copy.
			</Sheet.Description>
		</Sheet.Header>

		<div class="grid gap-4 border-b p-4">
			<Field.Group class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
				<Field.Field>
					<Field.Label for="snapshot-lens">Lens</Field.Label>
					<Select.Root
						type="single"
						value={lens}
						disabled={isBusy}
						onValueChange={(value) => {
							if (value && value !== lens) {
								lens = value as HomeSnapshotLens;
								operationGeneration += 1;
								snapshot = undefined;
								result = undefined;
								error = undefined;
							}
						}}
					>
						<Select.Trigger id="snapshot-lens" class="w-full">
							{lensOptions.find((option) => option.value === lens)?.label}
						</Select.Trigger>
						<Select.Content>
							{#each lensOptions as option (option.value)}
								<Select.Item value={option.value} label={option.label} />
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
				<Button onclick={capture} disabled={isBusy}>
					{#if isCapturing}<Spinner class="size-3.5" />{/if}
					{snapshot === undefined ? 'Capture' : 'Recapture'}
				</Button>
			</Field.Group>

			{#if snapshot}
				<p class="text-xs text-muted-foreground tabular-nums">
					{snapshot.recordCount} records after authority sequence {snapshot.sourceAuthorityAfterSequence}.
					This artifact is already stale if live data changed.
				</p>
			{/if}

			<Field.Field>
				<Field.Label for="snapshot-sql">SQL</Field.Label>
				<Textarea
					id="snapshot-sql"
					bind:value={sql}
					rows={5}
					spellcheck={false}
					class="font-mono text-xs"
					disabled={snapshot === undefined}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							void query();
						}
					}}
				/>
				<Field.Description>
					Read-only. Results stop at 500 rows or 5 MiB. Cmd/Ctrl+Enter runs.
				</Field.Description>
			</Field.Field>
			<div>
				<Button
					size="sm"
					onclick={query}
					disabled={snapshot === undefined || isBusy || !sql.trim()}
				>
					{#if isQuerying}<Spinner class="size-3.5" />{/if}
					Run query
				</Button>
			</div>
		</div>

		{#if error}
			<Alert.Root variant="destructive" class="m-4 w-auto">
				<Alert.Title>Data snapshot failed</Alert.Title>
				<Alert.Description>{error}</Alert.Description>
			</Alert.Root>
		{:else if result === undefined}
			<Empty.Root class="min-h-0 flex-1 border-0">
				<Empty.Title>Capture, then query</Empty.Title>
				<Empty.Description>
					Live application data remains on the typed Lens API.
				</Empty.Description>
			</Empty.Root>
		{:else if result.rows.length === 0}
			<Empty.Root class="min-h-0 flex-1 border-0">
				<Empty.Title>No rows matched</Empty.Title>
				<Empty.Description>The query completed against the captured artifact.</Empty.Description>
			</Empty.Root>
		{:else}
			<div class="min-h-0 flex-1 overflow-auto">
				<Table.Root class="text-sm">
					<Table.Caption>
						{result.rowCount} rows{result.truncated ? ' (capped)' : ''}
					</Table.Caption>
					<Table.Header>
						<Table.Row>
							{#each columns as column (column)}
								<Table.Head class="sticky top-0 bg-background font-mono text-xs">
									{column}
								</Table.Head>
							{/each}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each result.rows as row, index (index)}
							<Table.Row>
								{#each columns as column (column)}
									<Table.Cell class="max-w-80 truncate font-mono text-xs">
										{cell(row[column] ?? null)}
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
