import type { Recipe } from '../data';

/**
 * The built-in Recipes that ship in code, shown in the picker and the library
 * alongside the user's own. They cover the reshapes the category leans on
 * (Wispr Flow, Apple Writing Tools): an email, a reply, notes, a to-do list.
 * There is deliberately no "Clean" recipe; Polish owns meaning-preserving
 * cleanup on the automatic path, so a manual one would only duplicate it.
 *
 * Each is a plain {@link Recipe}: a name and one instruction, text in and text
 * out. Built-in ids carry the `builtin:` prefix so they never collide with a
 * user recipe's generated id, and so the library can show them read-only (a user
 * edits a copy, not the shipped original). See ADR-0099.
 */
export const BUILTIN_RECIPES: Recipe[] = [
	{
		id: 'builtin:email',
		name: 'Email',
		instructions:
			'Rewrite the text as a clear, friendly email. Keep the meaning and every concrete detail; fix the tone, flow, and structure. Do not invent a greeting or sign-off unless the text implies one.',
		icon: '✉️',
	},
	{
		id: 'builtin:reply',
		name: 'Reply',
		instructions:
			'Write a concise, natural reply to the message. Match its tone, answer what it asks, and keep it short.',
		icon: '↩️',
	},
	{
		id: 'builtin:notes',
		name: 'Notes',
		instructions:
			"Turn the text into concise bullet-point notes. One idea per bullet, in the speaker's own words, no preamble.",
		icon: '📝',
	},
	{
		id: 'builtin:todos',
		name: 'To-dos',
		instructions:
			'Extract the action items as a checklist. One to-do per line, each starting with a verb. Drop anything that is not an action.',
		icon: '✅',
	},
];

/** Whether `id` belongs to a built-in Recipe (read-only, ships in code). */
export function isBuiltinRecipeId(id: string): boolean {
	return id.startsWith('builtin:');
}
