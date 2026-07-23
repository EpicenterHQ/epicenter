<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import * as Sheet from '@epicenter/ui/sheet';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import * as Tabs from '@epicenter/ui/tabs';
	import {
		isHomeDataLens,
		type HomeDataCollectionPage,
		type HomeDataLens,
		type HomeDataOverview,
	} from '../home-data-service.ts';
	import {
		homeDataCollectionPath,
		HOME_DATA_OVERVIEW_ROUTE,
	} from '../routes.ts';

	const REFRESH_INTERVAL_MS = 5_000;

	let open = $state(false);
	let overview = $state.raw<HomeDataOverview>();
	let page = $state.raw<HomeDataCollectionPage>();
	let selectedLens = $state<HomeDataLens>('chat');
	let selectedCollection = $state('');
	let after = $state<string>();
	let previous = $state<string[]>([]);
	let error = $state<string>();
	let isLoading = $state(false);
	let generation = 0;

	const lens = $derived(
		overview?.lenses.find((entry) => entry.id === selectedLens),
	);
	const collection = $derived(
		lens?.collections.find((entry) => entry.key === selectedCollection),
	);
	const columns = $derived(
		collection?.kind === 'table'
			? ['id', ...collection.fields, 'state']
			: ['key', 'value', 'state'],
	);
	const workCount = $derived(
		overview === undefined
			? 0
			: overview.sync.work.scalar.pending +
				overview.sync.work.scalar.sealed +
				overview.sync.work.document.owed +
				overview.sync.work.blob.owed,
	);
	const parkedCount = $derived(overview?.parked.entries.length ?? 0);

	$effect(() => {
		if (!open) return;
		void refresh();
		const timer = setInterval(() => void refresh(false), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	});

	async function requestJson<TResult>(url: string): Promise<TResult> {
		const response = await fetch(url, {
			credentials: 'same-origin',
			cache: 'no-store',
		});
		if (!response.ok) {
			const message = await response.text();
			throw new Error(message || 'Live data request failed.');
		}
		return response.json() as Promise<TResult>;
	}

	async function readPage(
		lensId: HomeDataLens,
		collectionKey: string,
		cursor: string | undefined,
	): Promise<HomeDataCollectionPage> {
		const url = new URL(
			homeDataCollectionPath(lensId, collectionKey),
			location.origin,
		);
		url.searchParams.set('limit', '100');
		if (cursor !== undefined) url.searchParams.set('after', cursor);
		return requestJson<HomeDataCollectionPage>(url.href);
	}

	async function refresh(showLoading = true): Promise<void> {
		const activeGeneration = ++generation;
		if (showLoading) isLoading = true;
		error = undefined;
		try {
			const nextOverview = await requestJson<HomeDataOverview>(
				HOME_DATA_OVERVIEW_ROUTE.pattern,
			);
			if (activeGeneration !== generation) return;
			overview = nextOverview;
			const nextLens =
				nextOverview.lenses.find((entry) => entry.id === selectedLens) ??
				nextOverview.lenses[0];
			if (nextLens === undefined) {
				page = undefined;
				return;
			}
			selectedLens = nextLens.id;
			const nextCollection =
				nextLens.collections.find(
					(entry) => entry.key === selectedCollection,
				) ?? nextLens.collections[0];
			if (nextCollection === undefined) {
				selectedCollection = '';
				page = undefined;
				return;
			}
			selectedCollection = nextCollection.key;
			const nextPage = await readPage(nextLens.id, nextCollection.key, after);
			if (activeGeneration === generation) page = nextPage;
		} catch (cause) {
			if (activeGeneration !== generation) return;
			error = cause instanceof Error ? cause.message : 'Live data refresh failed.';
		} finally {
			if (activeGeneration === generation) isLoading = false;
		}
	}

	async function selectLens(value: string): Promise<void> {
		if (!isHomeDataLens(value) || value === selectedLens) return;
		selectedLens = value;
		selectedCollection =
			overview?.lenses.find((entry) => entry.id === value)?.collections[0]?.key ??
			'';
		after = undefined;
		previous = [];
		page = undefined;
		await refresh();
	}

	async function selectCollection(value: string): Promise<void> {
		if (value === '' || value === selectedCollection) return;
		selectedCollection = value;
		after = undefined;
		previous = [];
		page = undefined;
		await refresh();
	}

	async function nextPage(): Promise<void> {
		if (page?.nextAfter === undefined) return;
		previous = [...previous, after ?? ''];
		after = page.nextAfter;
		await refresh();
	}

	async function previousPage(): Promise<void> {
		const cursor = previous.at(-1);
		if (cursor === undefined) return;
		previous = previous.slice(0, -1);
		after = cursor === '' ? undefined : cursor;
		await refresh();
	}

	function format(value: unknown): string {
		if (value === undefined) return '';
		if (typeof value === 'string') return value;
		return JSON.stringify(value);
	}

	function cell(
		entry: HomeDataCollectionPage['entries'][number],
		column: string,
	): string {
		if (column === 'state') return entry.state;
		if (column === 'id' || column === 'key') return entry.recordKey;
		if (column === 'value') return format(entry.value);
		if (
			typeof entry.value === 'object' &&
			entry.value !== null &&
			!Array.isArray(entry.value)
		) {
			return format((entry.value as Record<string, unknown>)[column]);
		}
		return '';
	}

	function parkedReasons(
		entry: HomeDataOverview['parked']['entries'][number],
	): string {
		return [entry.scalar?.code, entry.document?.code, entry.blob?.code]
			.filter((value) => value !== undefined)
			.join(', ');
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm">Data</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content class="flex w-full flex-col gap-0 p-0 sm:max-w-4xl">
		<Sheet.Header class="border-b px-5 py-4 text-left">
			<Sheet.Title>Live data</Sheet.Title>
			<Sheet.Description>
				Browse the shared replica through installed Lenses and inspect work that
				cannot currently progress.
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
			<Badge variant="secondary">{overview?.sync.state ?? 'loading'}</Badge>
			<Badge variant={workCount === 0 ? 'status.completed' : 'status.running'}>
				{workCount} active
			</Badge>
			<Badge variant={parkedCount === 0 ? 'secondary' : 'status.failed'}>
				{parkedCount} parked
			</Badge>
			{#if overview?.attachment.kind === 'attached'}
				<Badge variant="outline">Attached</Badge>
			{:else if overview?.attachment.requiresChoice}
				<Badge variant="status.running">Attachment choice required</Badge>
			{/if}
			<Button
				class="ms-auto"
				variant="ghost"
				size="sm"
				disabled={isLoading}
				onclick={() => refresh()}
			>
				{#if isLoading}<Spinner class="size-3.5" />{/if}
				Refresh
			</Button>
		</div>

		{#if error}
			<Alert.Root variant="destructive" class="m-4 w-auto">
				<Alert.Title>Live data unavailable</Alert.Title>
				<Alert.Description>{error}</Alert.Description>
			</Alert.Root>
		{:else if overview === undefined}
			<Empty.Root class="min-h-0 flex-1 border-0">
				<Empty.Media><Spinner /></Empty.Media>
				<Empty.Title>Reading live data</Empty.Title>
				<Empty.Description>The record owner remains available to applications.</Empty.Description>
			</Empty.Root>
		{:else}
			<Tabs.Root value="browse" class="flex min-h-0 flex-1 flex-col">
				<Tabs.List class="mx-4 mt-3 w-fit">
					<Tabs.Trigger value="browse">Browse</Tabs.Trigger>
					<Tabs.Trigger value="parked">Parked ({parkedCount})</Tabs.Trigger>
				</Tabs.List>

				<Tabs.Content value="browse" class="flex min-h-0 flex-1 flex-col">
					<div class="grid gap-3 border-b p-4 sm:grid-cols-2">
						<Field.Field>
							<Field.Label for="live-data-lens">Lens</Field.Label>
							<Select.Root
								type="single"
								value={selectedLens}
								onValueChange={(value) => void selectLens(value)}
							>
								<Select.Trigger id="live-data-lens" class="w-full">
									{lens?.title ?? 'Select Lens'}
								</Select.Trigger>
								<Select.Content>
									{#each overview.lenses as entry (entry.id)}
										<Select.Item value={entry.id} label={entry.title} />
									{/each}
								</Select.Content>
							</Select.Root>
							{#if lens}<Field.Description>{lens.namespace}</Field.Description>{/if}
						</Field.Field>
						<Field.Field>
							<Field.Label for="live-data-collection">Collection</Field.Label>
							<Select.Root
								type="single"
								value={selectedCollection}
								onValueChange={(value) => void selectCollection(value)}
							>
								<Select.Trigger id="live-data-collection" class="w-full">
									{collection?.title ?? 'Select collection'}
								</Select.Trigger>
								<Select.Content>
									{#each lens?.collections ?? [] as entry (entry.key)}
										<Select.Item value={entry.key} label={entry.title} />
									{/each}
								</Select.Content>
							</Select.Root>
						</Field.Field>
					</div>

					{#if page === undefined || isLoading}
						<Empty.Root class="min-h-0 flex-1 border-0">
							<Empty.Media><Spinner /></Empty.Media>
							<Empty.Title>Reading collection</Empty.Title>
						</Empty.Root>
					{:else if page.entries.length === 0}
						<Empty.Root class="min-h-0 flex-1 border-0">
							<Empty.Title>No visible records</Empty.Title>
							<Empty.Description>
								This bounded page contains no records recognized by the selected Lens.
							</Empty.Description>
						</Empty.Root>
					{:else}
						<div class="min-h-0 flex-1 overflow-auto">
							<Table.Root>
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
									{#each page.entries as entry (entry.recordKey)}
										<Table.Row>
											{#each columns as column (column)}
												<Table.Cell class="max-w-64 truncate font-mono text-xs" title={cell(entry, column)}>
													{cell(entry, column)}
												</Table.Cell>
											{/each}
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</div>
						<div class="flex items-center justify-between border-t p-3">
							<span class="text-xs text-muted-foreground">
								{page.entries.length} records on this page
							</span>
							<div class="flex gap-2">
								<Button size="sm" variant="outline" disabled={previous.length === 0} onclick={previousPage}>
									Previous
								</Button>
								<Button size="sm" variant="outline" disabled={page.nextAfter === undefined} onclick={nextPage}>
									Next
								</Button>
							</div>
						</div>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="parked" class="min-h-0 flex-1 overflow-auto p-4">
					{#if overview.parked.entries.length === 0}
						<Empty.Root class="min-h-full border-0">
							<Empty.Title>No parked work</Empty.Title>
							<Empty.Description>
								Every refused scalar, document, and blob operation has either progressed or been superseded.
							</Empty.Description>
						</Empty.Root>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head>Address</Table.Head>
									<Table.Head>Reason</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each overview.parked.entries as entry (`${entry.address.namespace}/${entry.address.collection}/${entry.address.recordKey}`)}
									<Table.Row>
										<Table.Cell class="font-mono text-xs">
											{entry.address.namespace}/{entry.address.collection}/{entry.address.recordKey}
										</Table.Cell>
										<Table.Cell>{parkedReasons(entry)}</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Tabs.Content>
			</Tabs.Root>
		{/if}
	</Sheet.Content>
</Sheet.Root>
