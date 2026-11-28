import { redirect } from '@sveltejs/kit';

/** Settings has no page of its own; the sidebar names each section. */
export const load = () => redirect(307, '/settings/transcription');
