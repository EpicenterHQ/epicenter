<!--
	Dev-only topology harness for the physical iPhone gate (spec
	20260717T212450, Wave H). TEMPORARY: delete with the WAVE_H_REMOVED_FEATURES
	ledger entry once the gate has produced its PASS/FAIL.

	Opens N row documents SIMULTANEOUSLY in this one page (the topology
	question is per-page socket count) and makes every gate check observable:
	per-document connection phase, downstream arrival, upstream sending,
	reconnect counts after backgrounding, hibernation repair, and deletion
	closure. Drive the same route from a laptop signed into the same account
	to make remote edits.

	Harness edits write a dedicated 'harness' Y.Text root beside the editor's
	'body' fragment, so pulses never corrupt ProseMirror content.
-->
<script lang="ts">
	import type { Note } from '@epicenter/honeycrisp';
	import type { RecordDocumentConnectionStatus } from '@epicenter/document-sync';
	import { Button } from '@epicenter/ui/button';
	import { InstantString } from '@epicenter/field';
	import { onDestroy } from 'svelte';
	import { auth } from '#platform/auth';
	import type { HoneycrispNoteDocument } from '$lib/application.js';
	import { getHoneycrispApp } from '$lib/context.js';

	const honeycrisp = getHoneycrispApp();

	const COUNTS = [1, 2, 4, 8];
	const TITLE_PREFIX = 'Topology harness';

	const initialCount =
		Number(new URLSearchParams(location.search).get('n')) || 1;
	let requestedCount = $state(initialCount);

	type Panel = {
		rowId: string;
		title: string;
		opened: HoneycrispNoteDocument | undefined;
		status: RecordDocumentConnectionStatus | undefined;
		/** Times the connection re-entered `connected` (reconnect counter). */
		connectedCount: number;
		text: string;
		lastChangeAt: string | undefined;
		revoked: string | undefined;
		openError: string | undefined;
		unsubscribe: (() => void) | undefined;
	};

	let panels = $state.raw<Panel[]>([]);
	let openGeneration = 0;
	let pulseTimer: ReturnType<typeof setInterval> | undefined;
	let pulsing = $state(false);

	const isSignedIn = $derived(auth.state.status === 'signed-in');

	function refreshPanel(panel: Panel): void {
		if (!panel.opened) return;
		try {
			panel.text = panel.opened.document.get('harness').toString();
		} catch (cause) {
			panel.revoked = cause instanceof Error ? cause.message : String(cause);
			panel.unsubscribe?.();
			panel.unsubscribe = undefined;
		}
		panels = [...panels];
	}

	async function listAllNotes(): Promise<Note[]> {
		return (await honeycrisp.notes.scan()).rows;
	}

	async function ensureRows(count: number): Promise<Note[]> {
		const mine = (await listAllNotes())
			.filter((note) => note.title.startsWith(TITLE_PREFIX))
			.sort((a, b) => a.title.localeCompare(b.title));
		for (let index = mine.length; index < count; index += 1) {
			const now = InstantString.now();
			const note = await honeycrisp.notes.create({
				title: `${TITLE_PREFIX} ${String(index + 1).padStart(2, '0')}`,
				preview: 'Topology gate row',
				pinned: false,
				createdAt: now,
				updatedAt: now,
			});
			mine.push(note);
		}
		return mine.slice(0, count);
	}

	async function openPanels(count: number): Promise<void> {
		const generation = ++openGeneration;
		for (const panel of panels) {
			panel.unsubscribe?.();
			void panel.opened?.[Symbol.asyncDispose]();
		}
		panels = [];
		const rows = await ensureRows(count);
		if (generation !== openGeneration) return;
		const next: Panel[] = rows.map((note) => ({
			rowId: note.id,
			title: note.title,
			opened: undefined,
			status: undefined,
			connectedCount: 0,
			text: '',
			lastChangeAt: undefined,
			revoked: undefined,
			openError: undefined,
			unsubscribe: undefined,
		}));
		panels = next;
		await Promise.all(
			next.map(async (panel) => {
				try {
					const opened = await honeycrisp.openNoteDocument(panel.rowId);
					if (generation !== openGeneration) {
						await opened[Symbol.asyncDispose]();
						return;
					}
					panel.opened = opened;
					panel.status = opened.connection.status;
					const offStatus = opened.connection.subscribeStatus((status) => {
						if (
							status === 'connected' &&
							panel.status !== 'connected'
						) {
							panel.connectedCount += 1;
						}
						panel.status = status;
						panels = [...panels];
					});
					const text = opened.document.get('harness');
					const observer = () => {
						panel.lastChangeAt = new Date().toLocaleTimeString();
						refreshPanel(panel);
					};
					text.observe(observer);
					panel.unsubscribe = () => {
						offStatus?.();
						try {
							text.unobserve(observer);
						} catch {
							// The document may already be revoked/destroyed.
						}
					};
					refreshPanel(panel);
				} catch (cause) {
					panel.openError =
						cause instanceof Error ? cause.message : String(cause);
					panels = [...panels];
				}
			}),
		);
	}

	function edit(panel: Panel): void {
		if (!panel.opened) return;
		try {
			const text = panel.opened.document.get('harness');
			panel.opened.document.transact(() => {
				text.insert(
					text.length,
					`${text.length === 0 ? '' : '\n'}${location.hostname} ${new Date().toISOString()}`,
				);
			});
		} catch (cause) {
			panel.revoked = cause instanceof Error ? cause.message : String(cause);
			panels = [...panels];
		}
	}

	function editAll(): void {
		for (const panel of panels) edit(panel);
	}

	function togglePulse(): void {
		if (pulseTimer) {
			clearInterval(pulseTimer);
			pulseTimer = undefined;
			pulsing = false;
			return;
		}
		pulsing = true;
		pulseTimer = setInterval(editAll, 5000);
	}

	async function deleteRow(panel: Panel): Promise<void> {
		try {
			await honeycrisp.notes.delete(panel.rowId);
		} catch (cause) {
			panel.openError = cause instanceof Error ? cause.message : String(cause);
			panels = [...panels];
		}
	}

	/** Post-gate cleanup: delete every harness-created row, open panels included. */
	async function deleteHarnessRows(): Promise<void> {
		openGeneration += 1;
		for (const panel of panels) {
			panel.unsubscribe?.();
			void panel.opened?.[Symbol.asyncDispose]();
		}
		panels = [];
		for (const note of await listAllNotes()) {
			if (!note.title.startsWith(TITLE_PREFIX)) continue;
			await honeycrisp.notes.delete(note.id);
		}
	}

	function setCount(count: number): void {
		requestedCount = count;
		const url = new URL(location.href);
		url.searchParams.set('n', String(count));
		history.replaceState(null, '', url);
		void openPanels(count);
	}

	void openPanels(initialCount);

	onDestroy(() => {
		openGeneration += 1;
		if (pulseTimer) clearInterval(pulseTimer);
		for (const panel of panels) {
			panel.unsubscribe?.();
			void panel.opened?.[Symbol.asyncDispose]();
		}
	});

	function phaseLabel(
		status: RecordDocumentConnectionStatus | undefined,
	): string {
		if (!status) return 'not opened';
		switch (status) {
			case 'connecting':
				return 'connecting';
			case 'connected':
				return 'connected';
			case 'offline':
				return 'offline';
			case 'authentication-required':
				return 'authentication required';
			case 'refused':
				return 'refused';
			case 'revoked':
				return 'revoked';
			case 'disposed':
				return 'disposed';
		}
	}
</script>

<svelte:head><title>Topology harness</title></svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-4">
	<h1 class="text-lg font-semibold">Row-document topology harness</h1>
	{#if !isSignedIn}
		<p class="rounded border border-destructive p-2 text-sm">
			Signed out: documents open locally but no sockets exist. Sign in first;
			the gate measures authenticated document sockets.
		</p>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		{#each COUNTS as count (count)}
			<Button
				variant={requestedCount === count ? 'default' : 'outline'}
				size="sm"
				onclick={() => setCount(count)}
			>
				{count} open
			</Button>
		{/each}
		<Button variant="outline" size="sm" onclick={editAll}>Edit all</Button>
		<Button variant="outline" size="sm" onclick={togglePulse}>
			{pulsing ? 'Stop pulse' : 'Pulse every 5s'}
		</Button>
		<Button
			variant="destructive"
			size="sm"
			onclick={() => void deleteHarnessRows()}
		>
			Delete harness rows
		</Button>
	</div>
	<p class="text-xs text-muted-foreground">
		Connected {panels.filter((panel) => panel.status === 'connected')
			.length}/{panels.length}. Background the app, wait, foreground: every
		panel must reconnect and show edits made meanwhile. Delete a row from the
		other device: its panel must show revoked.
	</p>
	<div class="flex flex-col gap-3">
		{#each panels as panel (panel.rowId)}
			<div class="rounded border p-3 text-sm">
				<div class="flex items-center justify-between gap-2">
					<span class="font-medium">{panel.title}</span>
					<span class="text-xs text-muted-foreground">{panel.rowId}</span>
				</div>
				{#if panel.openError}
					<p class="text-destructive">open failed: {panel.openError}</p>
				{:else if panel.revoked}
					<p class="text-destructive">revoked: {panel.revoked}</p>
				{:else}
					<p>
						status: <span class="font-mono">{phaseLabel(panel.status)}</span>
						· reconnects: {Math.max(0, panel.connectedCount - 1)}
					</p>
					<p class="text-xs text-muted-foreground">
						{panel.text.split('\n').filter(Boolean).length} harness lines
						{#if panel.lastChangeAt}· last change {panel.lastChangeAt}{/if}
					</p>
					<div class="mt-2 flex gap-2">
						<Button variant="outline" size="sm" onclick={() => edit(panel)}>
							Edit
						</Button>
						<Button
							variant="outline"
							size="sm"
							onclick={() => void deleteRow(panel)}
						>
							Delete row
						</Button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
