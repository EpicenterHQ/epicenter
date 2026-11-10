/**
 * Where a book stands, from its days alone, as the app reads it: no
 * `started` is a book I mean to read, `started` alone one I am reading,
 * and `finished` one I have read. Days are `YYYY-MM-DD`, which sort as text
 * in the order they fall.
 */
import type { Book } from './books.svelte.js';

export type Shelf = {
	key: 'reading' | 'next' | 'read';
	label: string;
	books: Book[];
};

const newestFirst = (a: string | undefined, b: string | undefined) =>
	(b ?? '').localeCompare(a ?? '');

/** The books on each shelf that has any: reading, newest started first; to read, by title; read, newest finished first. */
export function shelves(books: Book[]): Shelf[] {
	const all: Shelf[] = [
		{
			key: 'reading',
			label: 'Reading',
			books: books
				.filter((book) => book.started && !book.finished)
				.toSorted((a, b) => newestFirst(a.started, b.started)),
		},
		{
			key: 'next',
			label: 'To read',
			books: books
				.filter((book) => !book.started && !book.finished)
				.toSorted((a, b) => a.title.localeCompare(b.title)),
		},
		{
			key: 'read',
			label: 'Read',
			books: books
				.filter((book) => book.finished)
				.toSorted((a, b) => newestFirst(a.finished, b.finished)),
		},
	];
	return all.filter((shelf) => shelf.books.length > 0);
}

/**
 * The page of the book at `path`: the hash route is the path itself,
 * `#/books/Dune.md`, each part encoded so any title survives.
 */
export const hrefOf = (path: string) => `#/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A day as a person reads it: `Nov 11`, with the year only when it is not this year's. */
export function dayLabel(day: string, today = new Date()): string {
	const [year, month, date] = day.split('-').map(Number) as [number, number, number];
	return new Date(year, month - 1, date, 12).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(year === today.getFullYear() ? {} : { year: 'numeric' }),
	});
}
