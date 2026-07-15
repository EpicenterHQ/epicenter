/**
 * A value that may be synchronous or wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Flatten a mapped or conditional type for IDE hover output.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};
