<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Select from '@epicenter/ui/select';
	import { toast } from 'svelte-sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import { cn } from '@epicenter/ui/utils';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ChevronsLeftIcon from '@lucide/svelte/icons/chevrons-left';
	import ChevronsRightIcon from '@lucide/svelte/icons/chevrons-right';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { pathOf } from './nav-items.js';
	import {
		captureDeletions,
		describeDeletions,
		nextSort,
		type RecordingSort,
		type RecordingSortKey,
		type RecordingStatus,
		deleteCaptured,
		pageOf,
		selectionIn,
		selectionReach,
		selectRange,
		shownRows,
		STATUS_LABELS,
		toggleRows,
		toggleSelected,
		transcribeRows,
		transcriptExcerpt,
		transcriptsToCopy,
		viewWith,
	} from '$lib/recordings-table.js';
	import { getLibrary } from '$lib/library.svelte.js';
	import { copyText } from './actions.js';
	import { formatLength, formatTime } from './format.js';
	import NoteRepair from './NoteRepair.svelte';

	/**
	 * Every recording as one table: search, sort, tick, and act on several.
	 * The search and sort run over every recording and the table draws one
	 * page of what they keep. The search text, the order, the page, and the
	 * ticks are the library's, so they are as they were after a visit to
	 * another page. Activating a row opens that recording's details; ticking
	 * one does not.
	 */
	let { onOpen }: {
		/** A recording was opened from its row: show its details. */
		onOpen: () => void;
	} = $props();

	const library = getLibrary();
	const { ui } = library;

	/** Every row the search keeps, in order, on every page. */
	const rows = $derived(shownRows(library, ui.recordingQuery, ui.recordingSort));
	const hidden = $derived(library.entries.length - rows.length);
	/** The rows drawn. Past the last page, as after deleting its rows, this is the last page. */
	const page = $derived(pageOf(rows, ui.recordingPage));
	const selection = $derived(selectionIn(ui.recordingSelected, rows, library));
	const selectedIds = $derived(new Set(selection.rows.map((row) => row.id)));
	const pageSelected = $derived(page.rows.filter((row) => selectedIds.has(row.id)).length);
	const pageAllSelected = $derived(page.rows.length > 0 && pageSelected === page.rows.length);
	const reach = $derived(selectionReach(selectedIds, page, rows));
	const busy = $derived(ui.recordingBulk !== undefined);
	const searching = $derived(ui.recordingQuery.trim() !== '');

	/** Search, sort, or turn the page. A new search or order starts at the first page. */
	function show(change: Parameters<typeof viewWith>[1]) {
		Object.assign(ui, viewWith(ui, change));
	}

	let scroller = $state<HTMLElement | null>(null);
	/** Turn to page `index`, from the top of its rows. */
	function turnTo(index: number) {
		show({ recordingPage: index });
		scroller?.scrollTo({ top: 0 });
	}

	/** The row last ticked or cleared: a shift-click ticks from it to the row clicked. */
	let anchor: string | undefined;
	/** Whether Shift was held for the click that is changing a tick now. */
	let shiftHeld = false;
	function tickRow(id: string, on: boolean) {
		ui.recordingSelected = shiftHeld
			? selectRange(ui.recordingSelected, page.rows, anchor, id, on, library)
			: toggleSelected(ui.recordingSelected, id, on, library);
		anchor = id;
		shiftHeld = false;
	}

	const formatCount = (n: number) => n.toLocaleString();

	/**
	 * The columns beside the title, shown only when the list is wide. Narrower,
	 * as on a phone or in a split pane, the title and excerpt take the row's
	 * whole width and these read as one line under them.
	 */
	const wideColumn = 'hidden @3xl:table-cell';
	const columns: { key: RecordingSortKey; label: string; class: string }[] = [
		{ key: 'title', label: 'Recording', class: 'w-auto' },
		{ key: 'recordedAt', label: 'Recorded', class: `w-44 ${wideColumn}` },
		{ key: 'durationMs', label: 'Length', class: `w-20 ${wideColumn}` },
		{ key: 'status', label: 'Status', class: `w-40 ${wideColumn}` },
	];

	/** Status sorts in the order its labels are listed. */
	const statusLabels = Object.values(STATUS_LABELS);
	/** Every order the columns can be sorted in, in words, one group per column: the narrow list's sort, without its column headers. */
	const orderGroups: { sort: RecordingSort; label: string }[][] = [
		[
			{ sort: { key: 'recordedAt', direction: 'desc' }, label: 'Newest first' },
			{ sort: { key: 'recordedAt', direction: 'asc' }, label: 'Oldest first' },
		],
		[
			{ sort: { key: 'title', direction: 'asc' }, label: 'Title A to Z' },
			{ sort: { key: 'title', direction: 'desc' }, label: 'Title Z to A' },
		],
		[
			{ sort: { key: 'durationMs', direction: 'desc' }, label: 'Longest first' },
			{ sort: { key: 'durationMs', direction: 'asc' }, label: 'Shortest first' },
		],
		[
			{ sort: { key: 'status', direction: 'asc' }, label: `${statusLabels[0]} first` },
			{ sort: { key: 'status', direction: 'desc' }, label: `${statusLabels[statusLabels.length - 1]} first` },
		],
	];
	const orders = orderGroups.flat();
	const orderValue = ({ key, direction }: RecordingSort) => `${key} ${direction}`;
	const order = $derived(orders.find(({ sort }) => orderValue(sort) === orderValue(ui.recordingSort)));

	const statusTone: Record<RecordingStatus, string> = {
		transcribing: 'text-foreground',
		untranscribed: 'text-muted-foreground',
		transcribed: 'text-muted-foreground',
	};

	function openRow(id: string) {
		if (library.openRecording(id)) onOpen();
	}

	const several = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
	/** Up to a few reasons, so a long run still reads as one message. */
	const reasons = (items: readonly { title: string; reason: string }[]) =>
		items
			.slice(0, 4)
			.map(({ title, reason }) => `“${title}”: ${reason}`)
			.concat(items.length > 4 ? [`and ${items.length - 4} more`] : [])
			.join('\n');

	async function copySelected() {
		const { text, copied, without } = transcriptsToCopy(selection.rows);
		if (copied === 0) {
			toast.info('None of the selected recordings has a transcript to copy');
			return;
		}
		await copyText(
			text,
			`${several(copied, 'transcript', 'transcripts')}${without > 0 ? ` (${without} selected had none)` : ''}`,
		);
	}

	/** Sent only by this press: one request for each selected recording that has no transcript, one at a time. */
	async function transcribeSelected() {
		if (busy) return;
		const ids = selection.rows.map((row) => row.id);
		ui.recordingBulk = { label: 'Transcribing', done: 0, total: ids.length };
		try {
			const outcome = await transcribeRows(library, ids, (done) => {
				ui.recordingBulk = { label: 'Transcribing', done, total: ids.length };
			});
			const summary = [
				several(outcome.transcribed.length, 'recording transcribed', 'recordings transcribed'),
				...(outcome.failed.length > 0 ? [`${outcome.failed.length} failed`] : []),
				...(outcome.skipped.length > 0 ? [`${outcome.skipped.length} not sent`] : []),
			].join(', ');
			const description = reasons([...outcome.failed, ...outcome.skipped]) || undefined;
			if (outcome.failed.length > 0) toast.error(summary, { description });
			else if (outcome.transcribed.length === 0) toast.info(summary, { description });
			else toast.success(summary, { description });
		} finally {
			ui.recordingBulk = undefined;
		}
	}

	/** Each deletion is captured first, as a single deletion is; the person confirms exactly those. */
	async function deleteSelected() {
		if (busy) return;
		const captured = captureDeletions(
			library,
			selection.rows.map((row) => row.id),
		);
		if (captured.deletions.length === 0) {
			toast.error('None of the selected recordings can be deleted now', { description: reasons(captured.refused) });
			return;
		}
		confirmationDialog.open({
			...describeDeletions(captured),
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				ui.recordingBulk = { label: 'Deleting', done: 0, total: captured.deletions.length };
				try {
					const { deleted, problems } = await deleteCaptured(library, captured.deletions);
					if (problems.length > 0)
						toast.error(`${several(deleted, 'recording', 'recordings')} deleted, ${problems.length} not`, {
							description: reasons(problems),
						});
					else if (problems.length === 0) toast.success(`${several(deleted, 'recording', 'recordings')} deleted`);
				} finally {
					ui.recordingBulk = undefined;
				}
			},
		});
	}
</script>

<section class="@container flex h-full min-h-0 flex-col" aria-label="Recordings">
	<div class="flex flex-col gap-3 border-b px-3 py-3 sm:px-4">
		<div class="flex flex-wrap items-end gap-x-4 gap-y-2">
			<SectionHeader.Root class="min-w-0 flex-1">
				<SectionHeader.Title level={1} class="text-lg">Recordings</SectionHeader.Title>
				<SectionHeader.Description class="text-xs">
					{several(library.entries.length, 'recording', 'recordings')}{#if hidden > 0}, {hidden} hidden by the search{/if}
				</SectionHeader.Description>
			</SectionHeader.Root>
			<Select.Root
				type="single"
				bind:value={
					() => orderValue(ui.recordingSort),
					(value) => show({ recordingSort: orders.find(({ sort }) => orderValue(sort) === value)?.sort ?? ui.recordingSort })
				}
			>
				<Select.Trigger size="sm" class="@3xl:hidden" aria-label="Sort recordings" data-testid="recording-sort">
					{order?.label}
				</Select.Trigger>
				<Select.Content align="end" class="whitespace-nowrap">
					{#each orderGroups as group, i (group[0]?.sort.key)}
						{#if i > 0}<Select.Separator />{/if}
						<Select.Group>
							{#each group as { sort, label } (orderValue(sort))}
								<Select.Item value={orderValue(sort)} {label} />
							{/each}
						</Select.Group>
					{/each}
				</Select.Content>
			</Select.Root>
			<div class="relative w-full @3xl:w-72">
				<SearchIcon class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input
					type="search"
					class="ps-8"
					bind:value={() => ui.recordingQuery, (recordingQuery) => show({ recordingQuery })}
					placeholder="Search titles, notes, and transcripts"
					aria-label="Search recordings"
					autocomplete="off"
					data-testid="recording-filter"
				/>
			</div>
		</div>

		{#if selection.rows.length > 0 || selection.hidden > 0 || ui.recordingBulk}
			<div class="flex flex-wrap items-center gap-2 text-sm" role="toolbar" aria-label="Selected recordings" data-testid="recording-selection">
				<span class="text-muted-foreground" role="status">
					{#if ui.recordingBulk}
						<Spinner class="mr-1 inline size-3.5" />
						{ui.recordingBulk.label} {ui.recordingBulk.done} of {ui.recordingBulk.total}…
					{:else if selection.rows.length > 0}
						<!--
							Actions are on every ticked row the search keeps, on every page. What a search hides
							stays ticked and is left alone.
						-->
						{#if reach === 'all'}
							All {formatCount(rows.length)}{searching ? ' matching' : ''} recordings are selected
						{:else if reach === 'page'}
							All {formatCount(page.rows.length)} on this page are selected{#if selection.rows.length > pageSelected}, and
								{formatCount(selection.rows.length - pageSelected)} on other pages{/if}.
							<Button
								variant="link"
								size="sm"
								class="h-auto p-0"
								onclick={() => (ui.recordingSelected = toggleRows(ui.recordingSelected, rows, true, library))}
								data-testid="select-every-match"
							>
								Select all {formatCount(rows.length)}{searching ? ' matching' : ''}
							</Button>
						{:else if pageSelected === 0}
							{formatCount(selection.rows.length)} selected on other pages
						{:else}
							{formatCount(selection.rows.length)} selected{#if selection.rows.length > pageSelected}, {formatCount(
									selection.rows.length - pageSelected,
								)} on other pages{/if}
						{/if}{#if selection.hidden > 0}.
							{selection.hidden} more selected {selection.hidden === 1 ? 'is' : 'are'} hidden by the search and not included{/if}
					{:else}
						None of the recordings shown is selected. {selection.hidden} selected {selection.hidden === 1 ? 'is' : 'are'} hidden by the
						search; clear the search to act on {selection.hidden === 1 ? 'it' : 'them'}
					{/if}
				</span>
				<span class="ml-auto flex flex-wrap items-center gap-1.5">
					<Button
						size="sm"
						variant="outline"
						disabled={busy || selection.rows.length === 0}
						onclick={() => void transcribeSelected()}
						data-testid="transcribe-selected"
					>
						Transcribe {formatCount(selection.rows.length)}
					</Button>
					<Button size="sm" variant="outline" disabled={selection.rows.length === 0} onclick={() => void copySelected()} data-testid="copy-selected">
						Copy {selection.rows.length === 1 ? 'transcript' : 'transcripts'}
					</Button>
					<Button size="sm" variant="destructive" disabled={busy || selection.rows.length === 0} onclick={() => void deleteSelected()} data-testid="delete-selected">
						Delete {formatCount(selection.rows.length)}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onclick={() => (ui.recordingSelected = [])}
						data-testid="clear-selection"
					>
						Clear selection
					</Button>
				</span>
			</div>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto" bind:this={scroller}>
		{#if rows.length > 0}
			<Table.Root class="table-fixed" aria-label="Saved recordings" data-testid="recording-list">
				<Table.Header>
					<Table.Row class="hover:bg-transparent">
						<Table.Head class="w-9 ps-3 sm:ps-4">
							<Checkbox
								checked={pageAllSelected}
								indeterminate={pageSelected > 0 && !pageAllSelected}
								onCheckedChange={(checked) =>
									(ui.recordingSelected = toggleRows(ui.recordingSelected, page.rows, checked === true, library))}
								aria-label={pageAllSelected
									? 'Clear the selection on this page'
									: page.count > 1
										? 'Select every recording on this page'
										: 'Select every recording shown'}
								data-testid="select-all"
							/>
						</Table.Head>
						{#each columns as column (column.key)}
							{@const sorted = ui.recordingSort.key === column.key ? ui.recordingSort.direction : undefined}
							<Table.Head
								class={column.class}
								aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
							>
								<Button
									variant="ghost"
									size="sm"
									class="-ms-2.5 {sorted ? '' : 'text-muted-foreground'}"
									onclick={() => show({ recordingSort: nextSort(ui.recordingSort, column.key) })}
									data-testid="sort-{column.key}"
								>
									{column.label}
									{#if sorted === 'asc'}<ArrowUpIcon />{:else if sorted === 'desc'}<ArrowDownIcon />{/if}
								</Button>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each page.rows as row (row.id)}
						{@const open = ui.showingDetail && library.selectedId === row.id}
						{@const excerpt = transcriptExcerpt(row, ui.recordingQuery)}
						{@const recorded = formatTime(row.note.recordedAt, 'short')}
						{@const duration = formatLength(row.note.durationMs)}
						<!--
							The title is the row's button, so the keyboard reaches and opens a row the usual way.
							A click anywhere else on the row opens it too, except in the tick's own cell.
						-->
						<Table.Row
							class="cursor-pointer"
							data-state={selectedIds.has(row.id) ? 'selected' : undefined}
							aria-current={open ? 'true' : undefined}
							onclick={() => void openRow(row.id)}
							data-testid="recording-row"
							data-id={row.id}
						>
							<Table.Cell class="ps-3 sm:ps-4" onclick={(event) => event.stopPropagation()}>
								<Checkbox
									checked={selectedIds.has(row.id)}
									onclick={(event) => (shiftHeld = event.shiftKey)}
									onCheckedChange={(checked) => tickRow(row.id, checked === true)}
									aria-label="Select {row.title}"
								/>
							</Table.Cell>
							<Table.Cell class="whitespace-normal">
								<div class="flex min-w-0 flex-col gap-0.5">
									<span class="flex min-w-0 items-center gap-2">
										<button
											type="button"
											class="min-w-0 truncate rounded-sm text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 {open ? 'underline underline-offset-4' : ''}"
											data-recording={row.id}
											onclick={(event) => {
												event.stopPropagation();
												void openRow(row.id);
											}}
										>
											{row.title}
										</button>
										{#if row.audio.kind === 'absent'}<Badge variant="outline" class="shrink-0" data-testid="row-audio-absent">No audio</Badge>{/if}
										{#if row.audio.kind === 'ambiguous'}<Badge variant="outline" class="shrink-0">Multiple audio files</Badge>{/if}
									</span>
									{#if excerpt !== undefined}
										<span class="line-clamp-2 text-xs break-words text-muted-foreground @3xl:line-clamp-1" data-testid="row-excerpt">
											{excerpt}
										</span>
									{/if}
									<span class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground @3xl:hidden" data-testid="row-meta">
										<span class={statusTone[row.status]}>
											{#if row.status === 'transcribing'}<Spinner class="mr-1 inline size-3" />{/if}
											{STATUS_LABELS[row.status]}
										</span>
										{#if recorded}<span aria-hidden="true">·</span><span>{recorded}</span>{/if}
										{#if duration}<span aria-hidden="true">·</span><span class="tabular-nums">{duration}</span>{/if}
									</span>
								</div>
							</Table.Cell>
							<Table.Cell class={cn('text-muted-foreground', wideColumn)}>{recorded}</Table.Cell>
							<Table.Cell class={cn('text-muted-foreground tabular-nums', wideColumn)}>{duration}</Table.Cell>
							<Table.Cell class={cn('truncate', statusTone[row.status], wideColumn)} data-testid="row-status">
								{#if row.status === 'transcribing'}<Spinner class="mr-1 inline size-3.5" />{/if}
								{STATUS_LABELS[row.status]}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{:else}
			<Empty.Root class="py-10">
				<Empty.Header>
					<Empty.Media variant="icon">
						{#if searching}<SearchIcon />{:else}<MicIcon />{/if}
					</Empty.Media>
					<Empty.Title>{searching ? 'No recordings match' : 'No recordings yet'}</Empty.Title>
					<Empty.Description>
						{#if searching}
							Nothing has “{ui.recordingQuery.trim()}” in its title, notes, or transcripts.
						{:else}
							Record from <Link href={pathOf('home')}>Home</Link>.
						{/if}
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}
	</div>

	{#if page.count > 1}
		<!-- After the rows, so Tab reaches the page's rows and then these. -->
		<nav class="flex items-center justify-end gap-1 border-t px-3 py-2 text-sm sm:px-4" aria-label="Pages of recordings" data-testid="recording-pages">
			<span class="me-2 text-muted-foreground tabular-nums" aria-live="polite">
				{formatCount(page.from)} to {formatCount(page.to)} of {formatCount(page.total)}
			</span>
			<Button variant="ghost" size="icon-sm" disabled={page.index === 0} onclick={() => turnTo(0)} aria-label="First page">
				<ChevronsLeftIcon />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				disabled={page.index === 0}
				onclick={() => turnTo(page.index - 1)}
				aria-label="Previous page"
				data-testid="previous-page"
			>
				<ChevronLeftIcon />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				disabled={page.index === page.count - 1}
				onclick={() => turnTo(page.index + 1)}
				aria-label="Next page"
				data-testid="next-page"
			>
				<ChevronRightIcon />
			</Button>
			<Button variant="ghost" size="icon-sm" disabled={page.index === page.count - 1} onclick={() => turnTo(page.count - 1)} aria-label="Last page">
				<ChevronsRightIcon />
			</Button>
		</nav>
	{/if}

	{#if library.repairs.length > 0}
		<div class="max-h-[50%] overflow-y-auto border-t bg-warning/10 px-3 py-2 text-xs" data-testid="recording-repairs">
			<p class="mb-2 font-medium">Needs repair</p>
			<div class="flex flex-col gap-4">
				{#each library.repairs as repair (repair.path)}
					<NoteRepair {repair} />
				{/each}
			</div>
		</div>
	{/if}
</section>
