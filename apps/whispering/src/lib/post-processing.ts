/**
 * What the post-processing choice can be, and how a chosen transformation is
 * named.
 *
 * The choice is a transformation's id, held by the product, which reads it
 * against the lists as `whispering.postProcessing`. Nothing here runs a
 * transformation.
 */
import type { TransformationNote } from './files.svelte.js';

/** A transformation's title, or its id when it has none. */
export function transformationName(
	note: Pick<TransformationNote, 'id' | 'title'>,
): string {
	return note.title || note.id;
}

export type PostProcessingChoice =
	| { readonly kind: 'none' }
	| { readonly kind: 'ready'; readonly entry: TransformationNote }
	/** Chosen and still listed, but it cannot run now; `reason` says why. */
	| {
			readonly kind: 'repair';
			readonly entry: TransformationNote;
			readonly reason: string;
	  }
	/** Chosen, and no longer among the transformations listed. */
	| { readonly kind: 'missing'; readonly id: string };
