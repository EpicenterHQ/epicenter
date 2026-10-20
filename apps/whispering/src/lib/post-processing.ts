/**
 * What the post-processing choice can be, and how a chosen transformation is
 * named.
 *
 * The choice is a transformation's path, held by the product, which reads it
 * against the folder as `whispering.postProcessing`. Nothing here runs a
 * transformation.
 */
import type { TransformationEntry } from './library.svelte.js';

/** A transformation's title, or its file when the title cannot be read. */
export function transformationName(entry: TransformationEntry): string {
	return (
		entry.row.fields.title || (entry.stem === '' ? entry.path : entry.stem)
	);
}

export type PostProcessingChoice =
	| { readonly kind: 'none' }
	| { readonly kind: 'ready'; readonly entry: TransformationEntry }
	/** Chosen and still in the folder, but it cannot run now; `reason` says why. */
	| {
			readonly kind: 'repair';
			readonly entry: TransformationEntry;
			readonly reason: string;
	  }
	/** Chosen, and no longer among the transformations the folder lists. */
	| { readonly kind: 'missing'; readonly path: string };
