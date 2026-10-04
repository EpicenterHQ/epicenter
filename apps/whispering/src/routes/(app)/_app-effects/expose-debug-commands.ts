import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { type BoundCommandRunners, commandRunners } from '$lib/commands';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

/**
 * Expose the command runners and router on `window` for DevTools poking while
 * the app surface is mounted, then restore whatever the host exposed before it.
 */
export function exposeDebugCommands(app: WhisperingApp): void {
	onMount(() => {
		const previousCommands = window.commands;
		const previousGoto = window.goto;
		// Bind the ready application so DevTools invocations run against it.
		window.commands = Object.fromEntries(
			Object.entries(commandRunners).map(([id, run]) => [
				id,
				(state?: Parameters<typeof run>[1]) => run(app, state),
			]),
		) as BoundCommandRunners;
		window.goto = goto;

		return () => {
			window.commands = previousCommands;
			window.goto = previousGoto;
		};
	});
}
