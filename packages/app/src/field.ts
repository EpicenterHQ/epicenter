/**
 * The fields an action's input is made of (ADR-0841). Each is a TypeBox
 * schema, so raw TypeBox sits beside them in the same input. The CLI reads a
 * field as a flag named for its key, or also as the command's positional when
 * it says `positional`; MCP shows it as a property of the tool's input.
 *
 * A field is required unless it says `optional`. A switch (`boolean`) and a
 * list (`tags`) are never required: an absent switch is `false`, an absent
 * list is empty.
 */
import {
	type TArray,
	type TBoolean,
	type TLiteral,
	type TOptional,
	type TSchema,
	type TString,
	type TUnion,
	Type,
} from 'typebox';

type Options = {
	description?: string;
	/** Also read from the command's one positional, as `epicenter reading log 30` is. */
	positional?: boolean;
};

type MaybeOptional = Options & { optional?: boolean };

type Optionally<T extends TSchema, O> = O extends { optional: true }
	? TOptional<T>
	: T;

/** A switch: `false` unless its flag is given. */
export type TSwitch = TOptional<TBoolean> & { default: false };

/** A list of text: every time its flag is given, or every positional; empty unless given. */
export type TTags = TOptional<TArray<TString>> & { default: string[] };

function maybeOptional<T extends TSchema, O extends MaybeOptional>(
	schema: T,
	options: O | undefined,
): Optionally<T, O> {
	return (options?.optional ? Type.Optional(schema) : schema) as Optionally<
		T,
		O
	>;
}

/** The schema options a field carries: its description, and whether it is the positional. */
function schemaOptions(options: Options | undefined) {
	return {
		...(options?.description === undefined
			? {}
			: { description: options.description }),
		...(options?.positional ? { positional: true } : {}),
	};
}

export const field = {
	text: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(Type.String(schemaOptions(options)), options),

	number: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(Type.Number(schemaOptions(options)), options),

	/** A day, written `2026-11-08`. */
	date: <const O extends MaybeOptional>(options?: O) =>
		maybeOptional(
			Type.String({
				...schemaOptions(options),
				pattern: '^\\d{4}-\\d{2}-\\d{2}$',
			}),
			options,
		),

	/** One of `values`, as `field.select(['archive', 'trash'])`. */
	select: <
		const V extends readonly [string, ...string[]],
		const O extends MaybeOptional,
	>(
		values: V,
		options?: O,
	) =>
		maybeOptional(
			Type.Union(
				values.map((value) => Type.Literal(value)),
				schemaOptions(options),
			) as unknown as TUnion<{ -readonly [K in keyof V]: TLiteral<V[K]> }>,
			options,
		),

	boolean: (options?: Omit<Options, 'positional'>): TSwitch =>
		Type.Optional(
			Type.Boolean({ ...schemaOptions(options), default: false }),
		) as TSwitch,

	tags: (options?: Options): TTags =>
		Type.Optional(
			Type.Array(Type.String(), { ...schemaOptions(options), default: [] }),
		) as TTags,
};

/** Whether `schema` is read from the command's positional. */
export function isPositional(schema: TSchema): boolean {
	return (schema as { positional?: unknown }).positional === true;
}
