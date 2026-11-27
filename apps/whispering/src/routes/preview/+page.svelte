<!--
	Development only. Home's recorder, its needs card, and the pill, handed a
	made-up `DictationView` instead of the real one, so every state can be
	seen without a microphone, including states of features not built yet
	(hold to talk, Hands-free, paste at the cursor). The screens cannot tell
	the difference: that is the line between what they show and how
	dictation happens.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type {
		DictationView,
		HandsFree,
		Need,
		Outcome,
		Take,
	} from '#lib/dictation-view.ts';
	import { setDictation } from '#lib/dictation-view.ts';
	import NeedsLine from '../NeedsLine.svelte';
	import Pill from '../Pill.svelte';
	import RecorderPanel from '../RecorderPanel.svelte';

	type Scene = {
		label: string;
		take?: Take;
		handsFree?: HandsFree;
		outcome?: Outcome;
		silent?: boolean;
		needs?: Need[];
		cleaning?: boolean;
	};

	const ACCESSIBILITY: Need = {
		id: 'accessibility',
		met: false,
		problem: 'Paste at the cursor is off: macOS has not allowed it. Text goes to your clipboard instead.',
		fix: { label: 'Allow in System Settings', href: '/settings/output' },
	};
	const SERVER: Need = {
		id: 'server',
		met: false,
		problem: 'No transcription server is set. Recordings are kept, without text.',
		fix: { label: 'Set up transcription', href: '/settings/transcription' },
	};

	const started = Date.now() - 17_000;
	const READY: Scene = { label: 'Ready' };
	const SCENES: Scene[] = [
		READY,
		{ label: 'Needs fixing', needs: [SERVER, ACCESSIBILITY] },
		{ label: 'Recording (shortcut)', take: { kind: 'recording', startedAt: started, trigger: 'shortcut' } },
		{ label: 'Recording (held key)', take: { kind: 'recording', startedAt: started, trigger: 'hold' } },
		{ label: 'Recording, silent mic', take: { kind: 'recording', startedAt: started, trigger: 'button' }, silent: true },
		{ label: 'Hands-free, listening', handsFree: { kind: 'listening' } },
		{ label: 'Hands-free, heard speech', handsFree: { kind: 'listening' }, take: { kind: 'recording', startedAt: started, trigger: 'voice' } },
		{ label: 'Saving', take: { kind: 'stopping' } },
		{ label: 'Hands-free, previous phrase', handsFree: { kind: 'listening' }, outcome: { kind: 'transcribing', id: 'x' } },
		{ label: 'Transcribing', outcome: { kind: 'transcribing', id: 'x' } },
		{ label: 'Cleaning up', outcome: { kind: 'transcribing', id: 'x' }, cleaning: true },
		{ label: 'Copied', outcome: { kind: 'delivered', id: 'x', to: 'clipboard', at: 0 } },
		{ label: 'Pasted', outcome: { kind: 'delivered', id: 'x', to: 'cursor', at: 0 } },
		{ label: 'Paste fell back', outcome: { kind: 'copiedInstead', id: 'x', why: 'the app in front would not take a paste.' } },
		{ label: 'Failed: no key', outcome: { kind: 'failed', id: 'x', label: 'Needs a key', why: 'The server needs an API key.', fix: { label: 'Set up transcription', href: '/settings/transcription' } } },
	];

	let scene = $state(READY);
	/** When the scene was picked: a delivery lands then, so the pill's moment can be watched. */
	let pickedAt = $state(Date.now());
	/** A level that moves like speech, so the meters can be judged. */
	let level = $state(0);
	$effect(() => {
		const timer = setInterval(() => (level = 0.02 + Math.random() * 0.3), 80);
		return () => clearInterval(timer);
	});

	const view: DictationView = {
		take: () => scene.take ?? { kind: 'idle' },
		keys: () => ({ toggle: '⌘⇧;', hold: '⌥Space' }),
		level: () => level,
		silent: () => scene.silent ?? false,
		handsFree: () => scene.handsFree ?? { kind: 'off' },
		outcome: () => {
			const outcome = scene.outcome ?? { kind: 'none' };
			return outcome.kind === 'delivered' ? { ...outcome, at: pickedAt } : outcome;
		},
		needs: () => scene.needs ?? [],
		isTranscribing: () => false,
		isCleaning: () => scene.cleaning ?? false,
		toggle: () => {},
		cancel: () => {},
		dismiss: () => (scene = READY),
		show: () => {},
		setHandsFree: () => {},
		transcribe: () => {},
		forget: () => {},
	};
	setDictation(view);
</script>

<svelte:head><title>Preview · Whispering</title></svelte:head>

<main class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="flex flex-wrap gap-1 border-b p-3" role="group" aria-label="State">
		{#each SCENES as option (option.label)}
			<Button
				size="sm"
				variant={scene === option ? 'secondary' : 'ghost'}
				aria-pressed={scene === option}
				onclick={() => {
					scene = option;
					pickedAt = Date.now();
				}}
			>
				{option.label}
			</Button>
		{/each}
	</div>

	<div class="mx-auto grid w-full max-w-4xl gap-8 p-6 md:grid-cols-[1fr_auto]">
		<section class="flex flex-col gap-4" aria-label="Home">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Home</h2>
			<RecorderPanel />
			<NeedsLine />
		</section>
		<section class="flex flex-col gap-4" aria-label="Pill">
			<h2 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pill, over other apps</h2>
			<div
				class="flex h-24 w-72 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground empty:before:content-['Hidden:_nothing_is_happening']"
			><Pill /></div>
		</section>
	</div>
</main>
