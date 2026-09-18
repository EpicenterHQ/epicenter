<script lang="ts">
	import type {
		PushPreview,
		PushResult,
		WorkingCopy,
	} from '@epicenter/app/artifact/checkout';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import FolderUpIcon from '@lucide/svelte/icons/folder-up';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { irreversible, renderPlan } from '$lib/folder-overview.js';
	import { reportBackgroundError } from '$lib/report.js';

	let { folder }: { folder: WorkingCopy } = $props();

	const honeycrisp = getHoneycrisp();

	/**
	 * The overview a person is looking at, and how to answer it.
	 *
	 * The working copy asks: it holds the reading this list came from, reads
	 * the folder again after the answer, and asks once more if anything moved
	 * (ADR-0341). Nothing here travels back into `push`, so there is no plan to
	 * keep and no staleness to track.
	 */
	let asking = $state<
		{ preview: PushPreview; stale: boolean; answer: (yes: boolean) => void } | undefined
	>(undefined);
	let outcome = $state<{ tone: 'held' | 'refused'; message: string } | undefined>(
		undefined,
	);
	let running = $state(false);
	let confirm = $state<HTMLButtonElement | null>(null);

	/** How many of these changes cannot be put back afterwards. */
	const cannotUndo = $derived(
		asking === undefined
			? 0
			: irreversible(asking.preview.plan, honeycrisp.tables.notes, 'push'),
	);

	/**
	 * The whole push as one block of plain text.
	 *
	 * Text rather than a list of components so a person can select it and paste
	 * it to the agent that made the mess (ADR-0330, ADR-0338). Everything a
	 * surface would have styled is a word here instead.
	 */
	const overview = $derived(
		asking === undefined
			? ''
			: renderPlan(asking.preview.plan, honeycrisp.tables.notes, 'push'),
	);

	async function send() {
		running = true;
		outcome = undefined;
		try {
			const { data, error } = await folder.push({
				confirm: (preview, { stale }) =>
					new Promise<boolean>((answer) => {
						asking = { preview, stale, answer };
					}),
			});
			asking = undefined;
			if (error !== null) {
				outcome = { tone: 'refused', message: unavailable(error.name) };
				return;
			}
			outcome = { tone: 'held', message: said(data) };
		} catch (cause) {
			// The library reports every refusal it plans for as a `Result`, so a
			// throw here is a bug rather than an outcome. It still cannot leave
			// the dialog open over a list that may no longer be true, and it must
			// not leave a person believing nothing happened: some of the push may
			// have landed.
			reportBackgroundError(cause);
			asking = undefined;
			outcome = {
				tone: 'refused',
				message:
					'Something went wrong partway through pushing. Read the folder again to see what landed.',
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

	/**
	 * What a push did, and what to do next where the answer is not "nothing".
	 *
	 * A file that became a note was renamed to an id nobody chose, so anything
	 * still working in that folder is looking at a name that is gone.
	 */
	function said(done: PushResult): string {
		if (done.status === 'unchanged') return 'Your folder matches your notes.';
		if (done.status === 'declined') return 'Nothing was sent back.';
		const parts: string[] = [];
		if (done.deleted > 0) {
			parts.push(
				`${done.deleted} note${done.deleted === 1 ? '' : 's'} deleted for good`,
			);
		}
		if (done.values > 0) {
			parts.push(`${done.values} value${done.values === 1 ? '' : 's'} changed`);
		}
		if (done.settings > 0) {
			parts.push(
				`${done.settings} setting${done.settings === 1 ? '' : 's'} changed`,
			);
		}
		if (done.bodies > 0) {
			parts.push(`${done.bodies} note${done.bodies === 1 ? '' : 's'} rewritten`);
		}
		if (done.admitted.length > 0) {
			const made = done.admitted.length;
			parts.push(`${made} new note${made === 1 ? '' : 's'}, renamed in the folder`);
		}
		return parts.length === 0
			? 'Nothing was sent back.'
			: `${parts.join(', ')} reached your notes.`;
	}

	function unavailable(name: string): string {
		switch (name) {
			case 'HostUnreachable':
				return 'This copy of Honeycrisp has no Epicenter folder to read.';
			case 'HostUnstated':
				return 'Your Epicenter folder answered in a way this version of Honeycrisp does not understand. Restarting Epicenter may fix it.';
			case 'HostRefused':
				return 'Your Epicenter folder could not be read. It may be on a drive that is not there.';
			case 'FolderUnwritten':
				return 'Nothing here wrote this folder, so nothing in it can be told apart from what you already have. Save notes as files first.';
			case 'Busy':
				return 'Your folder is already being read. Finish that first.';
			case 'PushUnapplied':
				return 'Part of the push could not be applied, and part of it may have landed. Read the folder again to see what did.';
			case 'FolderStale':
				return 'Your edits reached your notes, and the folder could not be written. Save notes as files to catch it up, and do not push again first: any file that became a note is still there under its old name and would be pushed twice.';
			default:
				return 'Your folder could not be read.';
		}
	}
</script>

<div class="flex flex-col gap-1 px-2">
	<Button
		variant="ghost"
		size="sm"
		class="justify-start gap-2 text-xs text-muted-foreground"
		disabled={running}
		tooltip="Bring changes you made to those files back into your notes"
		onclick={send}
	>
		<FolderUpIcon class="size-3.5" />
		{running ? 'Reading folder…' : 'Push folder edits back'}
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
		// vanished without one would leave the push waiting on a promise nothing
		// resolves, and the folder marked busy behind it.
		if (!isOpen) answer(false);
	}}
>
	<AlertDialog.Content
		class="max-w-2xl"
		onOpenAutoFocus={(event) => {
			// Enter pushes. bits-ui focuses the first focusable, which is Cancel,
			// and this dialog's whole shape is one approval of a list a person
			// just read (ADR-0338).
			event.preventDefault();
			confirm?.focus();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>
				Push {asking?.preview.plan.length ?? 0} change{asking?.preview.plan
					.length === 1
					? ''
					: 's'}{cannotUndo > 0 ? `, ${cannotUndo} you cannot get back` : ''}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{asking?.stale
					? 'The folder or your notes changed while you were reading, so nothing was pushed. This is what is true now.'
					: 'Everything below is applied together. Only the files listed here are rewritten; everything else in your folder stays exactly as it is. To change any of it: cancel, edit the file, push again.'}
			</AlertDialog.Description>
		</AlertDialog.Header>

		<pre
			class="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{overview}</pre>

		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				bind:ref={confirm}
				class={buttonVariants()}
				onclick={() => answer(true)}
			>
				Push all
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
