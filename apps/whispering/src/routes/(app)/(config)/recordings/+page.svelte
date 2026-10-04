<script lang="ts">
	import { createPersistedState } from '@epicenter/svelte';
	import { Badge } from '@epicenter/ui/badge';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as ButtonGroup from '@epicenter/ui/button-group';
	import { Card } from '@epicenter/ui/card';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as Table from '@epicenter/ui/table';
	import { SelectAllPopover, SortableTableHeader } from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import { cn } from '@epicenter/ui/utils';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import MicIcon from '@lucide/svelte/icons/mic';
	import StartTranscriptionIcon from '@lucide/svelte/icons/play';
	import RetryTranscriptionIcon from '@lucide/svelte/icons/repeat';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { createMutation } from '@tanstack/svelte-query';
	import {
		createTable as createSvelteTable,
		FlexRender,
		renderComponent,
	} from '@tanstack/svelte-table';
	import type {
		ColumnDef,
		ColumnFiltersState,
		PaginationState,
	} from '@tanstack/table-core';
	import {
		getCoreRowModel,
		getFilteredRowModel,
		getPaginationRowModel,
		getSortedRowModel,
	} from '@tanstack/table-core';
	import { type } from 'arktype';
	import { createRawSnippet } from 'svelte';
	import { PATHS } from '$lib/services/fs-paths';
	import { report } from '$lib/report';
	import { tauri } from '#platform/tauri';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/recordings';
	import type { Recording } from '$lib/state/recordings.svelte';
	import type { RecordingId } from '$lib/workspace';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import RecordingTranscriptCell from './RecordingTranscriptCell.svelte';
	import RecordingAudioCell from './RecordingAudioCell.svelte';
	import RecordingStorageBadge from './RecordingStorageBadge.svelte';
	import TranscriptionStatusBadge from './TranscriptionStatusBadge.svelte';
	import RecordingRowActions from './actions/RecordingRowActions.svelte';
	import {
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();

	/**
	 * Returns a cell renderer for an instant, optionally using a row-owned
	 * display timezone.
	 */
	function formattedCell(getTimeZone?: (recording: Recording) => string) {
		return ({
			getValue,
			row,
		}: {
			getValue: () => unknown;
			row: { original: Recording };
		}) => {
			const value = getValue();
			if (typeof value !== 'string' || !value) return '';
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			const timeZone = getTimeZone?.(row.original);
			const options: Intl.DateTimeFormatOptions = {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				timeZone,
				...(timeZone ? { timeZoneName: 'short' } : {}),
			};
			try {
				return new Intl.DateTimeFormat(undefined, options).format(date);
			} catch {
				return new Intl.DateTimeFormat(undefined, {
					...options,
					timeZone: undefined,
					timeZoneName: undefined,
				}).format(date);
			}
		};
	}

	const transcribeRecordings = createMutation(
		() => queries.transcription.transcribeRecordings.options,
	);

	function displayTranscript(recording: Recording): string {
		return recording.polishedTranscript ?? recording.transcript;
	}

	const columns = [
		{
			id: 'select',
			header: ({ table }) =>
				renderComponent(SelectAllPopover<Recording>, { table }),
			cell: ({ row }) =>
				renderComponent(Checkbox, {
					checked: row.getIsSelected(),
					onCheckedChange: (value) => row.toggleSelected(!!value),
					'aria-label': 'Select row',
				}),
			enableSorting: false,
			enableHiding: false,
			filterFn: (row, _columnId, filterValue) => {
				const title = String(row.getValue('title'));
				const transcript = displayTranscript(row.original);
				return (
					title.toLowerCase().includes(filterValue.toLowerCase()) ||
					transcript.toLowerCase().includes(filterValue.toLowerCase())
				);
			},
		},
		{
			accessorKey: 'id',
			meta: { label: 'ID' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, { column, headerText: 'ID' }),
			cell: ({ getValue }) => {
				const id = getValue<string>();
				return renderComponent(Badge, {
					variant: 'id',
					children: createRawSnippet(() => ({
						render: () => id,
					})),
				});
			},
		},
		{
			accessorKey: 'title',
			meta: { label: 'Title' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Title',
				}),
		},
		{
			accessorKey: 'recordedAt',
			meta: { label: 'Recorded' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Recorded',
				}),
			cell: formattedCell((recording) => recording.recordedAtZone),
		},
		{
			id: 'transcript',
			accessorFn: displayTranscript,
			meta: { label: 'Transcript' },
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Transcript',
				}),
			cell: ({ row }) =>
				renderComponent(RecordingTranscriptCell, {
					recordingId: row.original.id,
				}),
		},
		{
			id: 'audio',
			meta: { label: 'Audio' },
			accessorFn: (recording) => recording,
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Audio',
				}),
			cell: ({ getValue }) =>
				renderComponent(RecordingAudioCell, {
					recording: getValue<Recording>(),
				}),
		},
		{
			id: 'storage',
			meta: { label: 'Storage' },
			accessorFn: (recording) => recording,
			header: 'Storage',
			enableSorting: false,
			cell: ({ getValue }) =>
				renderComponent(RecordingStorageBadge, {
					recording: getValue<Recording>(),
				}),
		},
		{
			id: 'status',
			meta: { label: 'Status' },
			accessorFn: ({ id }) => id,
			header: 'Status',
			enableSorting: false,
			cell: ({ getValue }) =>
				renderComponent(TranscriptionStatusBadge, {
					recordingId: getValue<RecordingId>(),
				}),
		},
		{
			id: 'actions',
			meta: { label: 'Actions' },
			accessorFn: (recording) => recording,
			header: ({ column }) =>
				renderComponent(SortableTableHeader, {
					column,
					headerText: 'Actions',
				}),
			cell: ({ getValue }) => {
				const recording = getValue<Recording>();
				return renderComponent(RecordingRowActions, { recording });
			},
		},
	] satisfies ColumnDef<Recording>[];

	let sorting = createPersistedState({
		key: 'whispering-recordings-data-table-sorting',
		schema: type({ desc: 'boolean', id: 'string' }).array(),
		defaultValue: [{ id: 'recordedAt', desc: true }],
	});
	let columnFilters = $state<ColumnFiltersState>([]);
	let columnVisibility = createPersistedState({
		key: 'whispering-recordings-data-table-column-visibility',
		schema: type('Record<string, boolean>'),
		defaultValue: {
			id: false,
		},
	});
	let rowSelection = createPersistedState({
		key: 'whispering-recordings-data-table-row-selection',
		schema: type('Record<string, boolean>'),
		defaultValue: {},
	});
	let pagination = $state<PaginationState>({ pageIndex: 0, pageSize: 10 });
	let globalFilter = $state('');

	const table = createSvelteTable({
		getRowId: (originalRow) => originalRow.id,
		get data() {
			return app.recordings.sorted;
		},
		columns,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		onSortingChange: (updater) => {
			if (typeof updater === 'function') {
				sorting.current = updater(sorting.current);
			} else {
				sorting.current = updater;
			}
		},
		onColumnFiltersChange: (updater) => {
			if (typeof updater === 'function') {
				columnFilters = updater(columnFilters);
			} else {
				columnFilters = updater;
			}
		},
		onColumnVisibilityChange: (updater) => {
			if (typeof updater === 'function') {
				columnVisibility.current = updater(columnVisibility.current);
			} else {
				columnVisibility.current = updater;
			}
		},
		onRowSelectionChange: (updater) => {
			if (typeof updater === 'function') {
				rowSelection.current = updater(rowSelection.current);
			} else {
				rowSelection.current = updater;
			}
		},
		onPaginationChange: (updater) => {
			if (typeof updater === 'function') {
				pagination = updater(pagination);
			} else {
				pagination = updater;
			}
		},
		onGlobalFilterChange: (updater) => {
			if (typeof updater === 'function') {
				globalFilter = updater(globalFilter);
			} else {
				globalFilter = updater;
			}
		},
		state: {
			get sorting() {
				return sorting.current;
			},
			get columnFilters() {
				return columnFilters;
			},
			get columnVisibility() {
				return columnVisibility.current;
			},
			get rowSelection() {
				return rowSelection.current;
			},
			get pagination() {
				return pagination;
			},
			get globalFilter() {
				return globalFilter;
			},
		},
	});

	const selectedRecordingRows = $derived(
		table.getFilteredSelectedRowModel().rows,
	);

	let template = $state('{{recordedAt}} {{transcript}}');
	let delimiter = $state('\n\n');

	let isDialogOpen = $state(false);

	const joinedTranscriptionsText = $derived.by(() => {
		const transcriptions = selectedRecordingRows
			.map(({ original }) => original)
			.filter((recording) => displayTranscript(recording) !== '')
			.map((recording) =>
				template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
					if (key === 'transcript') return displayTranscript(recording);
					if (key in recording) {
						const value = recording[key as keyof Recording];
						return typeof value === 'string' ? value : '';
					}
					return '';
				}),
			);
		return transcriptions.join(delimiter);
	});

	async function openBlobsFolder() {
		if (!tauri) return;
		const { error } = await tauri.opener.openPath(await PATHS.DB.BLOBS());
		if (error) report.error({ title: 'Failed to open folder', cause: error });
	}
</script>

<svelte:head> <title>All Recordings</title> </svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<SectionHeader.Root>
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Recordings
		</SectionHeader.Title>
		<SectionHeader.Description>
			Your latest recordings and transcriptions, stored locally
			{tauri ? 'on your file system' : 'in IndexedDB'}.
		</SectionHeader.Description>
	</SectionHeader.Root>
	<Card class="flex flex-col gap-4 p-6">
		<div class="flex flex-col md:flex-row items-center justify-between gap-2">
			<Input
				placeholder="Filter transcripts..."
				type="text"
				class="w-full md:max-w-sm"
				bind:value={globalFilter}
			/>
			<div class="flex w-full items-center justify-between gap-2">
				{#if selectedRecordingRows.length > 0}
					<Button
						tooltip="Transcribe selected recordings"
						variant="outline"
						size="icon"
						disabled={transcribeRecordings.isPending}
						onclick={() => {
							const loading = report.loading({
								title: 'Transcribing recordings...',
								description: 'This may take a while.',
							});
							transcribeRecordings.mutate(
								selectedRecordingRows.map(({ original }) => original),
								{
									onSuccess: ({ oks, errs }) => {
										const historyUnconfirmedTexts = oks.flatMap(({ data }) =>
											data.history.error === null ? [] : [data.text],
										);
										const historyWarningCount = historyUnconfirmedTexts.length;
										const copyUnsavedAction =
											historyWarningCount === 0
												? undefined
												: {
														label: 'Copy unsaved transcripts',
														onClick: () =>
															createCopyFn('unsaved transcripts')(
																historyUnconfirmedTexts.join('\n\n'),
															),
													};
										if (errs.length === 0) {
											const count = oks.length;
											loading.resolve({
												title: `Transcribed ${count} recording${count === 1 ? '' : 's'}`,
												description:
													historyWarningCount === 0
														? `Your ${count} recording${count === 1 ? ' has' : 's have'} been transcribed successfully.`
														: `Recording history may be incomplete for ${historyWarningCount} transcription${historyWarningCount === 1 ? '' : 's'}.`,
												action: copyUnsavedAction,
											});
											return;
										}

										// transcribeAndPersist attempts to mark each failed row so
										// history can surface its message plus a retry. So the bulk toast only
										// summarizes, and forwards the first real failure as the
										// cause so More details stays a genuine provider error
										// rather than a synthesized one. Dedupe the messages so a
										// batch that failed the same way (every row missing the API
										// key) reads as one line, not N copies.
										const [firstFailure] = errs;
										if (!firstFailure) return; // errs is non-empty here
										const failureSummary = [
											...new Set(errs.map(({ error }) => error.message)),
										].join('\n');

										if (oks.length === 0) {
											loading.reject({
												cause: firstFailure.error,
												title: `Failed to transcribe ${errs.length} recording${errs.length === 1 ? '' : 's'}`,
												description: failureSummary,
											});
											return;
										}

										loading.reject({
											cause: firstFailure.error,
											title: `Transcribed ${oks.length} of ${oks.length + errs.length} recordings`,
											description: `${oks.length} succeeded, ${errs.length} failed${historyWarningCount === 0 ? '' : `, ${historyWarningCount} may not have been saved to history`}:\n${failureSummary}`,
											action: copyUnsavedAction,
										});
									},
								},
							);
						}}
					>
						{#if transcribeRecordings.isPending}
							<EllipsisIcon class="size-4" />
						{:else if selectedRecordingRows.some(
							(recording) =>
								app.recordings.get(recording.original.id)?.transcription?.status ===
								'completed',
						)}
							<RetryTranscriptionIcon class="size-4" />
						{:else}
							<StartTranscriptionIcon class="size-4" />
						{/if}
					</Button>

					<Modal.Root
						open={isDialogOpen}
						onOpenChange={(v) => (isDialogOpen = v)}
					>
						<Modal.Trigger>
							<Button
								tooltip="Copy transcripts from selected recordings"
								variant="outline"
								size="icon"
							>
								<CopyIcon class="size-4" />
							</Button>
						</Modal.Trigger>
						<Modal.Content>
							<Modal.Header>
								<Modal.Title>Copy Transcripts</Modal.Title>
								<Modal.Description>
									Choose the template and delimiter for the selected
									transcripts.
								</Modal.Description>
							</Modal.Header>
							<div class="grid gap-4 py-4">
								<div class="grid grid-cols-4 items-center gap-4">
									<Label for="template" class="text-right">Template</Label>
									<Textarea
										id="template"
										bind:value={template}
										class="col-span-3"
									/>
								</div>
								<div class="grid grid-cols-4 items-center gap-4">
									<Label for="delimiter" class="text-right">Delimiter</Label>
									<Textarea
										id="delimiter"
										bind:value={delimiter}
										class="col-span-3"
									/>
								</div>
							</div>
							<Textarea
								placeholder="Preview of copied text"
								readonly
								class="h-32"
								value={joinedTranscriptionsText}
							/>
							<Modal.Footer>
								<CopyButton
									text={joinedTranscriptionsText}
									copyFn={createCopyFn('transcripts')}
									size="default"
									onCopy={(status) => {
										if (status === 'success') isDialogOpen = false;
									}}
								>
									Copy Transcriptions
								</CopyButton>
							</Modal.Footer>
						</Modal.Content>
					</Modal.Root>

					<Button
						tooltip="Delete selected recordings"
						variant="outline"
						size="icon"
						onclick={() =>
							deleteRecordingsWithConfirmation(
								app,
								selectedRecordingRows.map(({ original }) => original),
							)}
					>
						<TrashIcon class="size-4" />
					</Button>
				{/if}

				{#if tauri}
					<Button
						tooltip="Open audio storage folder"
						variant="outline"
						size="icon"
						onclick={openBlobsFolder}
					>
						<ExternalLinkIcon class="size-4" />
					</Button>
				{/if}

				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class={cn(
							buttonVariants({ variant: 'outline' }),
							'ml-auto items-center transition-all [&[data-state=open]>svg]:rotate-180',
						)}
					>
						Columns
						<ChevronDownIcon class="size-4 transition-transform duration-200" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content>
						{#each table
							.getAllColumns()
							.filter((c) => c.getCanHide()) as column (column.id)}
							<DropdownMenu.CheckboxItem
								bind:checked={() => column.getIsVisible(),
									(value) => column.toggleVisibility(!!value)}
							>
								{(column.columnDef.meta as { label?: string })?.label ?? column.id}
							</DropdownMenu.CheckboxItem>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>

		<div class="rounded-md border">
			<Table.Root>
				<Table.Header>
					{#each table.getHeaderGroups() as headerGroup}
						<Table.Row>
							{#each headerGroup.headers as header}
								<Table.Head colspan={header.colSpan}>
									{#if !header.isPlaceholder}
										<FlexRender
											content={header.column.columnDef.header}
											context={header.getContext()}
										/>
									{/if}
								</Table.Head>
							{/each}
						</Table.Row>
					{/each}
				</Table.Header>
				<Table.Body>
					{#if table.getRowModel().rows?.length}
						{#each table.getRowModel().rows as row (row.id)}
							<Table.Row>
								{#each row.getVisibleCells() as cell}
									<Table.Cell>
										<FlexRender
											content={cell.column.columnDef.cell}
											context={cell.getContext()}
										/>
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{:else}
						<Table.Row>
							<Table.Cell colspan={columns.length}>
								<Empty.Root class="py-8">
									<Empty.Header>
										<Empty.Media variant="icon">
											{#if globalFilter}
												<SearchIcon />
											{:else}
												<MicIcon />
											{/if}
										</Empty.Media>
										<Empty.Title>
											{#if globalFilter}
												No recordings found
											{:else}
												No recordings yet
											{/if}
										</Empty.Title>
										<Empty.Description>
											{#if globalFilter}
												Try adjusting your search or filters.
											{:else}
												Start recording to add one.
											{/if}
										</Empty.Description>
									</Empty.Header>
								</Empty.Root>
							</Table.Cell>
						</Table.Row>
					{/if}
				</Table.Body>
			</Table.Root>
		</div>

		<div class="flex items-center justify-between">
			<div class="text-muted-foreground text-sm">
				{selectedRecordingRows.length}
				of
				{table.getFilteredRowModel().rows
					.length}
				row(s) selected.
			</div>
			<ButtonGroup.Root>
				<Button
					variant="outline"
					size="sm"
					onclick={() => table.previousPage()}
					disabled={!table.getCanPreviousPage()}
				>
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					onclick={() => table.nextPage()}
					disabled={!table.getCanNextPage()}
				>
					Next
				</Button>
			</ButtonGroup.Root>
		</div>
	</Card>
</main>
