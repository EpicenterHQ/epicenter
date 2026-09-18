<script lang="ts">
	import type {
		PullPreview,
		PullResult,
		WorkingCopy,
	} from '@epicenter/app/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderDownIcon from '@lucide/svelte/icons/folder-down';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { irreversible, renderPlan } from '$lib/folder-overview.js';
	import { reportBackgroundError } from '$lib/report.js';

	let { folder }: { folder: WorkingCopy } = $props();

	const honeycrisp = getHoneycrisp();

	/**
	 * What the last pull said, in the person's words.
	 *
	 * One line under the button rather than a toast, because it is the whole
	 * outcome of a deliberate act and there is exactly one place they are
	 * looking when they invoke it.
	 */
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	/**
	 * The folder a person is looking at before they write over it.
	 *
	 * The pull is already running when this appears: it holds the reading this
	 * list came from and is waiting on the answer, so nothing here is a list
	 * that could go stale in a component's hands (ADR-0341).
	 */
	let asking = $state<
		{ preview: PullPreview; stale: boolean; answer: (yes: boolean) => void } | undefined
	>(undefined);
	let running = $state(false);
	let confirm = $state<HTMLButtonElement | null>(null);

	/** How much of this folder a pull writes over. */
	const wouldLose = $derived.by(() => {
		const preview = asking?.preview;
		if (preview === undefined) return 0;
		return preview.base ? preview.plan.length : preview.unwritten.length;
	});
	/** How much of that cannot be put back afterwards. */
	const cannotUndo = $derived.by(() => {
		const preview = asking?.preview;
		if (preview === undefined) return 0;
		return preview.base
			? irreversible(preview.plan, honeycrisp.tables.notes, 'pull')
			: preview.unwritten.length;
	});

	/**
	 * What the pull would write over, as the block the push dialog renders.
	 *
	 * One renderer for both directions: this is the same plan read from the
	 * other end, and two renderers meant two answers to what a note is called.
	 */
	const wouldGo = $derived.by(() => {
		const preview = asking?.preview;
		if (preview === undefined) return '';
		if (!preview.base) return preview.unwritten.map((path) => `  ${path}`).join('\n');
		return renderPlan(preview.plan, honeycrisp.tables.notes, 'pull');
	});

	async function write() {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await folder.pull({
				confirm: (preview, { stale }) =>
					// Nothing here is anybody's work, so there is nothing to
					// approve, and a dialog listing no changes is a question with
					// one answer. The library asks on every pull because a pull
					// always writes; deciding not to show it is this side's.
					preview.base && preview.plan.length === 0
						? Promise.resolve(true)
						: !preview.base && preview.unwritten.length === 0
							? Promise.resolve(true)
							: new Promise<boolean>((answer) => {
									asking = { preview, stale, answer };
								}),
			});
			asking = undefined;
			if (error !== null) {
				outcome = { tone: 'refused', message: refusal(error.name) };
				return;
			}
			outcome = { tone: 'held', message: said(data) };
		} catch (cause) {
			// The library reports every refusal it plans for as a `Result`, so a
			// throw here is a bug rather than an outcome, and it must not leave
			// the dialog open over a list that may no longer be true.
			reportBackgroundError(cause);
			asking = undefined;
			outcome = {
				tone: 'refused',
				message:
					'Something went wrong partway through writing the folder. Read it again to see what landed.',
			};
		} finally {
			running = false;
		}
	}

	/** Close the dialog with an answer, which is what the working copy is waiting on. */
	function answer(yes: boolean) {
		const open = asking;
		asking = undefined;
		open?.answer(yes);
	}

	function said(done: PullResult): string {
		if (done.status === 'declined') return 'Nothing was written.';
		const { files } = done;
		return `${files} file${files === 1 ? '' : 's'} written to your Epicenter folder.`;
	}

	/**
	 * What a person reads when a pull does not happen.
	 *
	 * `HostUnreachable` should be unreachable: `#platform/folder` hands out no
	 * working copy in a build with no filesystem, so this component is never
	 * mounted there. It keeps an arm anyway, because the honest sentence for
	 * "the folder is not there" is not the one for "the folder said no", and a
	 * build seam that slipped would otherwise tell somebody their disk was
	 * full.
	 */
	function refusal(name: string): string {
		switch (name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to write to.';
			case 'HostUnstated':
				return 'Your Epicenter folder answered in a way this version of Honeycrisp does not understand. Restarting Epicenter may fix it.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be written to. It may be full, read only, or on a drive that is not there.';
			case 'Busy':
				return 'Your folder is already being written. Finish that first.';
			case 'Unrenderable':
				return 'Some notes could not be written as files, so nothing was written. Nothing on this device changed.';
			default:
				return 'Your notes could not be written to the folder.';
		}
	}
</script>

<div class="flex flex-col gap-1 px-2 pb-1">
	<Button
		variant="ghost"
		size="sm"
		class="justify-start gap-2 text-xs text-muted-foreground"
		disabled={running}
		tooltip="Write these notes into your Epicenter folder as files"
		onclick={write}
	>
		<FolderDownIcon class="size-3.5" />
		{running ? 'Writing files…' : 'Save notes as files'}
	</Button>
	{#if outcome}
		<p
			class="px-2 text-[11px] {outcome.tone === 'refused'
				? 'text-destructive'
				: 'text-muted-foreground'}"
		>
			{outcome.message}
		</p>
	{/if}
</div>

<AlertDialog.Root
	open={asking !== undefined}
	onOpenChange={(isOpen) => {
		// Closing by any route is an answer, and the answer is no. A dialog that
		// vanished without one would leave the pull waiting on a promise nothing
		// resolves, and the folder marked busy behind it.
		if (!isOpen) answer(false);
	}}
>
	<AlertDialog.Content
		class="max-w-2xl"
		onOpenAutoFocus={(event) => {
			// Enter pulls, the same way Enter pushes. Both verbs are one approval
			// of a list a person just read (ADR-0341).
			event.preventDefault();
			confirm?.focus();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{asking?.preview.base === false
					? `Write over ${wouldLose} file${wouldLose === 1 ? '' : 's'} nothing here wrote`
					: `Write over ${wouldLose} edit${wouldLose === 1 ? '' : 's'} in your folder`}{cannotUndo >
					0 && asking?.preview.base !== false
					? `, ${cannotUndo} you cannot get back`
					: ''}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{asking?.stale
					? 'Your folder or your notes changed while you were reading, so nothing was written. This is what is true now.'
					: asking?.preview.base === false
						? 'Nothing here wrote this folder, so nothing in it can be told apart from your notes. Every file below is replaced or removed.'
						: 'Every file is written from your notes. These are the edits in your folder that have not been pushed back.'}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<pre
			class="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{wouldGo}</pre>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				bind:ref={confirm}
				class={buttonVariants({ variant: 'destructive' })}
				onclick={() => answer(true)}
			>
				Write over them
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
