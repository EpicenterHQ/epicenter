<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as Popover from '@epicenter/ui/popover';
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Globe from '@lucide/svelte/icons/globe';
	import Plus from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { type Command, commands } from '$lib/commands';
	import { os } from '#platform/os';
	import { createAppShortcuts } from '$lib/shortcuts';
	import { getWhisperingApp } from '$lib/whispering/context';
	import { report } from '$lib/report';
	import {
		isEmptyBinding,
		keyBindingToLabel,
		type KeyBinding,
		type Reach,
	} from '$lib/utils/key-binding';
	import { createChordRecorder } from './create-chord-recorder';

	// The one router-driven recorder (ADR-0052): the user picks a key, never a
	// store. A command's two slots (focused, global) render as reach-glyphed chips,
	// and one "Add" popover captures a key while previewing, live, how far that key
	// will reach. The router (`shortcuts`) routes the write by realized reach; the
	// recorder never names a store.
	const { command }: { command: Command } = $props();

	// At most one focused and one global binding per command, so up to two chips.
	const shortcuts = createAppShortcuts(getWhisperingApp());

	const bindings = $derived(shortcuts.current(command.id));
	const chips = $derived(
		(['focused', 'global'] as const)
			.map((reach) => ({ reach, binding: bindings[reach] }))
			.filter(
				(slot): slot is { reach: Reach; binding: KeyBinding } =>
					slot.binding !== null && !isEmptyBinding(slot.binding),
			),
	);

	// ADR-0052 read-only reach text: where the shortcut fires, plus whether it syncs
	// (focused shortcuts live in the synced workspace; global ones are per-device).
	// One string feeds the glyph tooltip, the live preview, and the success toast.
	function reachLabel(reach: Reach): string {
		if (reach === 'focused')
			return 'Works in Whispering, synced across your devices';
		return 'Works everywhere on this computer';
	}

	// The popover's open state is the whole session: open means listening. The two
	// never diverge, so there is no separate `capturing` flag to keep in sync.
	let open = $state(false);
	// The combo held so far this session, so the popover can preview its reach
	// before the user releases. `null` between sessions.
	let previewBinding = $state.raw<KeyBinding | null>(null);
	const preview = $derived.by(() => {
		if (!previewBinding || isEmptyBinding(previewBinding)) return null;
		return {
			binding: previewBinding,
			realized: shortcuts.reachBadge(command.id, previewBinding),
		};
	});

	// One capture brain: the webview recorder captures bare keys for focused
	// shortcuts and chords for global shortcuts.
	const chordRecorder = createChordRecorder({
		onCapture: (next) => void commitCandidate(next),
		onProgress: (partial) => {
			previewBinding = partial;
		},
	});

	// The recorder runs while the popover is open. Closing or unmounting stops it.
	$effect(() => {
		if (!open) return;
		chordRecorder.start();
		return () => chordRecorder.stop();
	});

	// Persist a captured key, routed by realized reach: a bare key lands in-app and
	// a chord goes global on desktop. The recorder never names a store; the key's
	// reach decides. On a conflict it stays listening so the user can retry without
	// reopening.
	async function commitCandidate(next: KeyBinding) {
		// Check the backend the key will route into. Both refuse exact duplicates;
		// the global backend also refuses OS-reserved gestures. On a conflict, stay
		// open so the user can retry; the recorder has reset its own accumulation.
		const conflict = shortcuts.findConflict(command.id, next);
		if (conflict) {
			let reason: string;
			if (conflict.kind === 'reserved') {
				reason = conflict.reason;
			} else {
				const title =
					commands.find((candidate) => candidate.id === conflict.commandId)
						?.title ?? conflict.commandId;
				reason =
					conflict.kind === 'duplicate'
						? `Those keys already trigger "${title}". Pick a different combination.`
						: `Those keys are already used by "${title}", which also fires in this window. Pick a different combination.`;
			}
			report.error({
				title: 'That shortcut is not available',
				description: reason,
				cause: {
					name: 'ShortcutConflict',
					message: `${keyBindingToLabel(next, os.isApple)}: ${reason}`,
				},
			});
			previewBinding = null;
			return;
		}
		const realized = shortcuts.reachBadge(command.id, next);
		await shortcuts.set(command.id, next);
		report.success({
			title: `${command.title} set to ${keyBindingToLabel(next, os.isApple)}`,
			description: reachLabel(realized),
		});
		// Closing tears capture down through the effects' cleanup.
		previewBinding = null;
		open = false;
	}
</script>

{#snippet keyChip(binding: KeyBinding, reach: Reach)}
	<Kbd.Root>{keyBindingToLabel(binding, os.isApple)}</Kbd.Root>
	<span
		class="inline-flex items-center text-muted-foreground"
		title={reachLabel(reach)}
	>
		{#if reach === 'focused'}
			<AppWindow class="size-3.5" />
		{:else}
			<Globe class="size-3.5" />
		{/if}
		<span class="sr-only">{reachLabel(reach)}</span>
	</span>
{/snippet}

<div class="flex flex-wrap items-center justify-end gap-2">
	{#each chips as chip (chip.reach)}
		<div class="flex items-center gap-1.5">
			{@render keyChip(
				chip.binding,
				shortcuts.reachBadge(command.id, chip.binding),
			)}
			<Button
				variant="ghost"
				size="icon"
				class="size-6 shrink-0"
				onclick={() => void shortcuts.clear(command.id, chip.reach)}
			>
				<XIcon class="size-3.5" />
				<span class="sr-only">Clear {chip.reach} shortcut</span>
			</Button>
		</div>
	{/each}

	<Popover.Root
		{open}
		onOpenChange={(next) => {
			open = next;
			if (!next) previewBinding = null;
		}}
	>
		<Popover.Trigger>
			<Button
				variant="ghost"
				size="sm"
				class="h-8 font-normal text-muted-foreground"
			>
				<Plus class="size-3.5" />
				<span class="text-xs">Add</span>
			</Button>
		</Popover.Trigger>

		<Popover.Content class="w-72" align="end">
			<div class="space-y-3">
				<h4 class="text-sm font-medium leading-none">{command.title}</h4>

				<div
					class="flex h-16 flex-col items-center justify-center gap-1 rounded-md border border-input bg-muted/30 px-3 text-center"
					aria-live="polite"
				>
					{#if preview}
						<div class="flex items-center gap-1.5">
							{@render keyChip(preview.binding, preview.realized)}
						</div>
						<p class="text-xs text-muted-foreground">
							{reachLabel(preview.realized)}
						</p>
					{:else}
						<p class="text-sm font-medium">Press a key</p>
						<p class="text-xs text-muted-foreground">
							A bare key works in Whispering, a chord works everywhere.
						</p>
					{/if}
				</div>

			</div>
		</Popover.Content>
	</Popover.Root>
</div>
