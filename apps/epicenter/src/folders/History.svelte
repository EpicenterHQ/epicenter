<!--
	One folder's history (ADR-0824, ADR-0826, ADR-0828): its changes, newest
	first, each with who made it, when, and its marks; a file's versions, one
	shown as it was and any restored; and a mark naming the folder's last
	change. Each is a function of `@epicenter/folder/platform` (`folderLog`,
	`fileHistory`, `fileAt`, `restoreFolder`, `markFolder`), the same the CLI's
	`log`, `history`, `show`, `restore`, and `mark` call. A restore is a new
	change on the server, which the sync then brings here.
-->
<script lang="ts">
	import {
		fileAt,
		fileHistory,
		type FileVersion,
		folderLog,
		type LoggedChange,
		markFolder,
		restoreFolder,
	} from '@epicenter/folder/platform';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { Loading } from '@epicenter/ui/loading';
	import * as Sheet from '@epicenter/ui/sheet';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { root } from './app';
	import { folders } from './home.svelte';

	let {
		open = $bindable(),
		name,
		title,
	}: {
		open: boolean;
		/** The folder's directory in the Epicenter folder. */
		name: string;
		title: string;
	} = $props();

	/** The history functions' target: this folder, as the signed-in account. */
	function target() {
		const account = folders.account();
		return account === null ? null : { root, account, name };
	}

	let changes = $state.raw<{ log: LoggedChange[]; here: number | null } | null>(null);
	let error = $state<string | null>(null);
	let mark = $state('');
	/** The file whose versions are shown, and those versions. */
	let file = $state<string | null>(null);
	let versions = $state.raw<FileVersion[] | null>(null);
	/** One version shown as it was: its change, and its text or why it has none. */
	let shown = $state.raw<{ seq: number; text: string | null; note: string | null } | null>(null);

	async function readLog() {
		const at = target();
		if (at === null) return;
		const read = await folderLog({ ...at, limit: 100 });
		error = read.error?.message ?? null;
		changes = read.data;
	}

	async function openFile(path: string) {
		const at = target();
		if (at === null) return;
		file = path;
		versions = null;
		shown = null;
		const read = await fileHistory({ ...at, path, limit: 100 });
		if (read.error !== null) {
			toast.error(read.error.message);
			file = null;
			return;
		}
		versions = read.data.versions;
	}

	const strict = new TextDecoder('utf-8', { fatal: true });

	async function show(path: string, seq: number) {
		const at = target();
		if (at === null) return;
		if (shown?.seq === seq) return void (shown = null);
		const read = await fileAt({ ...at, path, at: String(seq) });
		if (read.error !== null)
			return void (shown = { seq, text: null, note: read.error.message });
		try {
			shown = { seq, text: strict.decode(read.data.bytes), note: null };
		} catch {
			shown = { seq, text: null, note: `${read.data.bytes.byteLength} bytes, not text` };
		}
	}

	async function restore(path: string, version: FileVersion) {
		const at = target();
		if (at === null) return;
		const restored = await restoreFolder({ ...at, path, at: String(version.seq) });
		if (restored.error !== null) return void toast.error(restored.error.message);
		toast.success(
			restored.data.written.length + restored.data.removed.length === 0
				? `${path} already holds that version.`
				: `${path} is back as it was at change ${version.seq}.`,
		);
		await folders.syncNow();
		await Promise.all([readLog(), openFile(path)]);
	}

	$effect(() => {
		if (open) void readLog();
	});

	/** A change's time, as this computer writes it. */
	const when = (at: string) => new Date(at).toLocaleString();
	/** An author without their email. */
	const who = (author: string) => author.replace(/\s*<[^>]*>$/, '') || author;
</script>

<Sheet.Root bind:open>
	<Sheet.Content class="w-full gap-0 sm:max-w-xl">
		<Sheet.Header>
			<Sheet.Title>History of {title}</Sheet.Title>
			<Sheet.Description>
				Every change saved to this folder, newest first. Restoring a version adds a change; nothing in between is lost.
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
			<form
				class="flex gap-2"
				onsubmit={async (event) => {
					event.preventDefault();
					const at = target();
					const named = mark.trim();
					if (at === null || named === '') return;
					const marked = await markFolder({ ...at, mark: named });
					if (marked.error !== null) return void toast.error(marked.error.message);
					toast.success(`${marked.data.name} marks change ${marked.data.seq}.`);
					mark = '';
					await readLog();
				}}
			>
				<Input aria-label="Name this moment" placeholder="Name this moment, such as v1" bind:value={mark} />
				<Button type="submit" variant="outline" disabled={mark.trim() === ''}>Mark</Button>
			</form>

			{#if error}
				<p role="alert" class="text-destructive">{error}</p>
			{:else if file !== null}
				{@const path = file}
				<div class="flex items-center gap-2">
					<Button variant="ghost" size="icon-sm" aria-label="All changes" onclick={() => (file = null)}>
						<ArrowLeftIcon />
					</Button>
					<code class="truncate">{path}</code>
				</div>
				{#if versions === null}
					<Loading />
				{:else}
					<Item.Group class="gap-2">
						{#each versions as version, index (version.seq)}
							<Item.Root variant="outline" size="sm" class="flex-wrap">
								<Item.Content>
									<Item.Title>
										{version.version === null ? 'Deleted' : `Change ${version.seq}`}
										{#each version.marks as named (named)}<Badge variant="secondary">{named}</Badge>{/each}
									</Item.Title>
									<Item.Description>{who(version.author)} · {when(version.at)}</Item.Description>
								</Item.Content>
								{#if version.version !== null}
									<Item.Actions>
										<Button size="sm" variant="ghost" onclick={() => show(path, version.seq)}>
											{shown?.seq === version.seq ? 'Hide' : 'View'}
										</Button>
										{#if index > 0}
											<Button size="sm" variant="outline" onclick={() => restore(path, version)}>Restore</Button>
										{/if}
									</Item.Actions>
								{/if}
								{#if shown?.seq === version.seq}
									{#if shown.text !== null}
										<pre class="max-h-72 w-full overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{shown.text}</pre>
									{:else}
										<p class="w-full text-muted-foreground">{shown.note}</p>
									{/if}
								{/if}
							</Item.Root>
						{/each}
					</Item.Group>
				{/if}
			{:else if changes === null}
				<Loading />
			{:else}
				<Item.Group class="gap-2">
					{#each changes.log as change (change.seq)}
						<Item.Root variant="outline" size="sm">
							<Item.Content>
								<Item.Title>
									{change.message?.split('\n')[0] || `Change ${change.seq}`}
									{#each change.marks as named (named)}<Badge variant="secondary">{named}</Badge>{/each}
									{#if change.seq === changes.here}<Badge variant="outline">This computer</Badge>{/if}
								</Item.Title>
								<Item.Description>{who(change.author)} · {when(change.at)}</Item.Description>
								<div class="flex flex-wrap gap-x-2">
									{#each change.files.slice(0, 6) as written (written.path)}
										<Button
											variant="link"
											size="sm"
											class="h-auto p-0 font-mono text-xs"
											onclick={() => openFile(written.path)}
										>
											{written.version === null ? `deleted ${written.path}` : written.path}
										</Button>
									{/each}
									{#if change.files.length > 6}
										<span class="text-xs text-muted-foreground">and {change.files.length - 6} more</span>
									{/if}
								</div>
							</Item.Content>
						</Item.Root>
					{:else}
						<Empty.Root class="border">
							<Empty.Header>
								<Empty.Title>No history yet</Empty.Title>
								<Empty.Description>Each change shows here once it syncs.</Empty.Description>
							</Empty.Header>
						</Empty.Root>
					{/each}
				</Item.Group>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
