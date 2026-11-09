/**
 * Schema Problem Tests
 *
 * A contract's note field is plain JSON, so a published contract validates
 * exactly as the field does in memory. `schemaProblem` names the first thing
 * a file could not hold, or answers `undefined`.
 *
 * Key behaviors:
 * - Callbacks, accessors, and TypeBox's runtime keywords are refused
 * - What JSON cannot write is refused: symbol keys, non-finite numbers,
 *   holes, non-plain objects, and a schema that contains itself
 * - `format` must be portable where it is a keyword, and is data elsewhere
 * - A `$ref` must resolve to a schema inside the field
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { schemaProblem } from './schema-problem.js';

test('a native refinement, guard, or codec is refused without being run', () => {
	let calls = 0;
	const counting = (value: unknown) => {
		calls += 1;
		return value !== null;
	};
	expect(schemaProblem(Type.Refine(Type.String(), counting))).toBe(
		'$.~refine is a runtime callback',
	);
	expect(
		schemaProblem(
			Type.Object({
				inner: Type.Refine(Type.Object({ a: Type.String() }), counting),
			}),
		),
	).toBe('$.properties.inner.~refine is a runtime callback');
	expect(calls).toBe(0);

	const guard = { check: () => true, errors: () => [] };
	expect(schemaProblem({ '~guard': guard, title: 'guarded' })).toBe(
		'$.~guard is a runtime callback',
	);
	const codec = Type.Codec(Type.String())
		.Decode((value) => value)
		.Encode((value) => value);
	expect(schemaProblem(Type.Array(codec))).toBe(
		'$.items.~codec is a runtime callback',
	);
});

test('a function anywhere is refused, at a schema position or inside data', () => {
	expect(schemaProblem({ type: 'string', 'x-check': () => true })).toBe(
		'$.x-check holds a runtime callback',
	);
	expect(
		schemaProblem(Type.Object({ a: Type.String({ default: () => 'now' }) })),
	).toBe('$.properties.a.default holds a runtime callback');
	expect(schemaProblem({ enum: ['a', () => 'b'] })).toBe(
		'$.enum.1 holds a runtime callback',
	);
});

test('an accessor is refused', () => {
	const nested = Type.Object({ a: Type.String() });
	Object.defineProperty(nested.properties.a, 'minLength', {
		enumerable: true,
		get: () => 2,
	});
	expect(schemaProblem(nested)).toBe('$.properties.a.minLength is an accessor');
});

test('what JSON cannot write is refused, and a shared schema is not a cycle', () => {
	const recursive: Record<string, unknown> = { type: 'object' };
	recursive.properties = { self: recursive };
	expect(schemaProblem({ type: 'string', [Symbol('s')]: 1 })).toBe(
		'$ has symbol keys',
	);
	expect(
		schemaProblem({ type: 'number', maximum: Number.POSITIVE_INFINITY }),
	).toBe('$.maximum is not a finite number');
	// biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
	expect(schemaProblem({ enum: [1, , 2] })).toBe('$.enum is sparse');
	expect(schemaProblem({ type: 'string', default: new Date(0) })).toBe(
		'$.default is not plain JSON',
	);
	expect(schemaProblem(recursive)).toBe(
		'$.properties.self refers back to itself',
	);
	expect(schemaProblem({ enum: ['a', undefined] })).toBe(
		'$.enum.1 is undefined, which JSON cannot hold',
	);
	const shared = { type: 'string' };
	expect(
		schemaProblem({ type: 'object', properties: { a: shared, b: shared } }),
	).toBeUndefined();
});

test('a visible ~ keyword is refused in a schema and is an ordinary key in data', () => {
	expect(schemaProblem({ type: 'string', '~a': 1 })).toBe(
		'$.~a is not a JSON Schema keyword',
	);
	expect(
		schemaProblem({ type: 'object', default: { '~a': 1 }, const: { '~a': 1 } }),
	).toBeUndefined();
});

test('a format outside the portable set is refused where it is a keyword, and is data anywhere else', () => {
	expect(
		schemaProblem(Type.Object({ due: Type.String({ format: 'date-tme' }) })),
	).toBe("$.properties.due.format is not a portable format: 'date-tme'");
	expect(
		schemaProblem({
			dependencies: {
				a: { properties: { b: { type: 'string', format: 'bogus' } } },
			},
		}),
	).toBe(
		"$.dependencies.a.properties.b.format is not a portable format: 'bogus'",
	);
	expect(schemaProblem(Type.String({ format: 'email' }))).toBeUndefined();
	expect(
		schemaProblem({
			default: { format: 'nope' },
			const: { format: 'x' },
			enum: [{ format: 'x' }],
		}),
	).toBeUndefined();
	expect(schemaProblem(Type.Object({ format: Type.String() }))).toBeUndefined();
});

test('a reference must resolve to a schema inside the field', () => {
	expect(schemaProblem({ $ref: 'Missing' })).toBe(
		"$.$ref names 'Missing', which nothing in this field defines",
	);
	expect(
		schemaProblem({ $defs: { text: { type: 'string' } }, $ref: '#/$defs/txt' }),
	).toBe("$.$ref names '#/$defs/txt', which nothing in this field defines");
	expect(
		schemaProblem({ $defs: { n: { type: 'string' } }, $ref: '#/$defs/n/type' }),
	).toBe("$.$ref names '#/$defs/n/type', which is not a schema");
	expect(
		schemaProblem({
			$defs: { text: { type: 'string', minLength: 2 } },
			$ref: '#/$defs/text',
		}),
	).toBeUndefined();
	const Node = Type.Cyclic(
		{
			Node: Type.Object({
				value: Type.Number(),
				next: Type.Union([Type.Ref('Node'), Type.Null()]),
			}),
		},
		'Node',
	) as TSchema;
	expect(schemaProblem(Node)).toBeUndefined();
	expect(schemaProblem({ const: { $ref: 'Missing' } })).toBeUndefined();
});
