<script lang="ts">
	import { CAPTURES_TABLE } from '@epicenter/capture';
	import {
		type ImportReport,
		type LegacyBundle,
		readLegacyBundle,
		serializeLegacyBundle,
	} from '@epicenter/capture/legacy';
	import { rowStemOf } from '@epicenter/folder';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { type Captures, describeError, type Mode } from '$lib/captures.svelte.js';
	import { downloadText } from '$lib/download.js';

	// Captures made before this version lived in an account store, not in
	// files. This screen brings an export of them in, on request only:
	//   1. choose an export (a JSON file) saved earlier;
	//   2. import that export as Markdown files.
	// Nothing here runs unless a button is pressed.
	let {
		captures,
		onOpen,
	}: {
		captures: Captures;
		onOpen: (stem: string, mode: Mode) => void;
	} = $props();

	let bundle = $state.raw<LegacyBundle | undefined>();
	let bundleOrigin = $state('');
	let problems = $state.raw<readonly string[]>([]);
	let working = $state('');
	let report = $state.raw<ImportReport | undefined>();

	async function chooseFile(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		if (!file) return;
		report = undefined;
		try {
			const read = readLegacyBundle(JSON.parse(await file.text()));
			if (read.ok) {
				bundle = read.bundle;
				bundleOrigin = file.name;
				problems = [];
			} else {
				bundle = undefined;
				problems = read.problems;
			}
		} catch (cause) {
			bundle = undefined;
			problems = [`The file is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`];
		}
	}

	async function runImport() {
		if (!bundle) return;
		working = 'Importing…';
		const { data, error } = await captures.importLegacy(bundle);
		working = '';
		report = data ?? undefined;
		problems = error === null ? [] : [describeError(error)];
	}

	const count = (status: string) =>
		report?.documents.filter((document) => document.status === status).length ?? 0;
</script>

<h1 class="mb-2 text-lg font-semibold tracking-tight">Bring in earlier captures</h1>
<p class="mb-6 text-sm text-muted-foreground">
	Captures from before this version were kept in your Epicenter account. This copies an export of them into Markdown files here, and importing the same export twice adds nothing twice.
</p>

{#if problems.length}
	<Alert.Root variant="destructive" class="mb-6">
		<Alert.Description>
			<ul class="list-disc pl-5">{#each problems as problem (problem)}<li>{problem}</li>{/each}</ul>
		</Alert.Description>
	</Alert.Root>
{/if}
{#if working}<p role="status" class="mb-6 text-sm">{working}</p>{/if}

<section aria-label="Get an export" class="mb-8 rounded-xl border border-border p-4 sm:p-5">
	<h2 class="text-base font-semibold">1. Get an export</h2>
	<div class="mt-4 space-y-5 text-sm">
		<div>
			<label for="bundle-file" class="font-medium">From an export file</label>
			<p class="mb-2 text-muted-foreground">A JSON file saved from this screen earlier, on this or another device.</p>
			<input id="bundle-file" type="file" accept="application/json,.json" onchange={chooseFile} class="block text-sm" />
		</div>
	</div>
</section>

{#if bundle}
	<section aria-label="Import" class="mb-8 rounded-xl border border-border p-4 text-sm sm:p-5">
		<h2 class="text-base font-semibold">2. Import this export</h2>
		<p class="mt-2">From {bundleOrigin}, made {new Date(bundle.exportedAt).toLocaleString()}.</p>
		<ul class="mt-2 list-disc pl-5">
			<li>{bundle.captures.length} captures with {bundle.thoughts.length} thoughts</li>
			<li>{bundle.entries.length} earlier entries</li>
			<li>{bundle.unreadable.length} rows that could not be read (kept in a report)</li>
			<li>{bundle.captures.filter((capture) => capture.text === null).length + bundle.entries.filter((entry) => entry.text === null).length} with text that was not available on that device</li>
		</ul>
		<div class="mt-4 flex flex-wrap gap-3">
			<Button size="sm" disabled={working !== '' || captures.fenced} onclick={runImport}>Import as Markdown files</Button>
			<Button variant="outline" size="sm" onclick={() => bundle && downloadText(`capture-export-${bundle.exportedAt.slice(0, 10)}.json`, serializeLegacyBundle(bundle), 'application/json')}>Download this export</Button>
		</div>
	</section>
{/if}

{#if report}
	<section aria-label="Import result" class="rounded-xl border p-4 text-sm sm:p-5 {report.complete ? 'border-border' : 'border-destructive/50'}">
		<h2 class="text-base font-semibold">{report.complete ? 'Import finished' : 'Import is not complete'}</h2>
		{#if !report.complete}<p class="mt-1">Resolve what is listed below and import the same export again. What is already in place is not imported twice.</p>{/if}
		<ul class="mt-3 list-disc pl-5">
			<li>{count('created')} files created</li>
			<li>{count('identical')} already in place and now recorded</li>
			<li>{report.alreadyImported.length} imported before and left as they are</li>
			{#if count('differs')}<li class="text-destructive">{count('differs')} not imported: another file is at that name, and it was left alone</li>{/if}
			{#if count('failed')}<li class="text-destructive">{count('failed')} could not be written</li>{/if}
			<li>{report.diagnostics.unreadableBodies.length} with text that was not available; not imported, so a later export can bring them</li>
			<li>{report.diagnostics.unreadableRows} unreadable rows, {report.diagnostics.heldThoughts.length} held thoughts, and {report.diagnostics.emptyThoughts.length} empty thoughts, listed in the report</li>
		</ul>
		{#if report.receipt.status === 'failed'}
			<p role="alert" class="mt-3 text-destructive">The record of this import could not be saved: {report.receipt.message} The files are in place. Import the same export again to record them.</p>
		{/if}
		{#each report.problems as problem (problem)}<p role="alert" class="mt-3 text-destructive">{problem}</p>{/each}
		{#each report.documents.filter((document) => document.status === 'differs' || document.status === 'failed') as document (document.identity)}
			<p class="mt-2 break-words"><code>{document.path}</code>: {document.status === 'failed' ? document.message : 'another file is here'}</p>
		{/each}
		{#if report.documents.some((document) => document.structured)}
			<p class="mt-3">Some imported captures can only be edited as text, because their original text has Markdown that hides the Thoughts section. All of their text is in the file.</p>
		{/if}
		<p class="mt-3 break-words text-muted-foreground">Report: <code>{report.reportPath}</code>. Export kept at <code>{report.bundlePath}</code>. Record: <code>{report.receiptPath}</code>.</p>
		{#if report.documents.some((document) => document.status === 'created')}
			<ul class="mt-3 space-y-1">
				{#each report.documents.filter((document) => document.status === 'created').slice(0, 20) as document (document.identity)}
					{@const stem = rowStemOf(CAPTURES_TABLE, document.path)}
					<li>
						{#if stem !== undefined}
							<Button variant="link" size="sm" class="h-auto p-0" onclick={() => onOpen(stem, document.structured ? 'text' : 'capture')}>{document.identity}</Button>
						{:else}
							{document.identity}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
