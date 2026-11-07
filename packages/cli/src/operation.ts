/**
 * A platform operation as one description (ADR-0817, ADR-0827): its name,
 * the positionals and options a command line gives it, its summary, and a
 * JSON Schema for its input and its output. The CLI renders each as a
 * command (`cli.ts`), and `epicenter mcp` as a tool (`mcp.ts`); neither
 * writes a command or a tool by hand.
 *
 * An operation's code (`Implementation`) loads only when it runs: `run`
 * turns an input into an output and prints nothing, so the MCP server can
 * call it with stdout as its channel; `print` is how a person reads the
 * output. `--json` prints the output as it is, the same value an agent
 * gets as a tool's structured content.
 */
import type { Static, TObject, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { CommandSpec, OptionSpec } from './parse.ts';

/** A positional: the input key it fills, as `--help` names it. */
export type Positional = {
	key: string;
	label: string;
	optional?: true;
	/** Takes every positional from here on, as an array. */
	rest?: true;
};

/** An option: the input key it fills; its flag is the key in kebab case. A boolean is a switch. */
export type OptionArg = {
	key: string;
	/** The value's name in `--help`, such as `<id>`; absent for a switch. */
	value?: string;
	hidden?: true;
	short?: string;
};

/**
 * What an operation answers: its output, and whether it is a finding a
 * person acts on (exit 1); or why it could not do its work (exit 2).
 */
export type Answer<TOutput> = Result<
	{ output: TOutput; finding?: boolean },
	string
>;

/** An operation's code, loaded when it runs. */
export type Implementation<TInput, TOutput> = {
	run(input: TInput): Promise<Answer<TOutput>>;
	/** Writes the output for a person: the answer on stdout, the rest on stderr. */
	print(output: TOutput): void;
};

/** One platform operation, described. */
export type Description<
	TInput extends TObject = TObject,
	TOutput extends TObject = TObject,
> = {
	/** The command's word, and the tool's name. */
	name: string;
	summary: string;
	/** What `epicenter <name> --help` adds below the summary. */
	details?: string;
	args?: readonly Positional[];
	options?: readonly OptionArg[];
	input: TInput;
	output: TOutput;
};

/** An operation: its description, and its code, loaded when it runs. */
export type Operation = Description & {
	load(): Promise<Implementation<never, unknown>>;
};

/** Describe an operation; its schemas type its code (`ImplementationOf`). */
export const defineOperation = <
	TInput extends TObject,
	TOutput extends TObject,
>(
	description: Description<TInput, TOutput>,
) => description;

/** The code of the operation `TDescription` describes, typed by its schemas. */
export type ImplementationOf<
	TDescription extends Description<TObject, TObject>,
> = Implementation<
	Static<TDescription['input']>,
	Static<TDescription['output']>
>;

/** An operation: `description` with the code `load` loads. */
export const withCode = <TDescription extends Description<TObject, TObject>>(
	description: TDescription,
	load: () => Promise<ImplementationOf<TDescription>>,
): Operation => ({
	...description,
	load: load as Operation['load'],
});

/** `pushDeletions` as a flag: `push-deletions`. */
export const flagOf = (key: string) =>
	key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** `[<folder> [<name>]]`: the positionals as `--help` prints them. */
export function argsLine(args: readonly Positional[]): string {
	let line = '';
	for (const arg of [...args].reverse()) {
		const label = arg.rest ? `${arg.label} ...` : arg.label;
		line = arg.optional
			? `[${label}${line ? ` ${line}` : ''}]`
			: `${label}${line ? ` ${line}` : ''}`;
	}
	return line;
}

/** The operation as the command-line parser sees it. */
export function commandOf(operation: Operation): CommandSpec {
	const args = operation.args ?? [];
	return {
		path: [operation.name],
		args: argsLine(args),
		minArgs: args.filter((arg) => !arg.optional).length,
		maxArgs: args.some((arg) => arg.rest)
			? Number.POSITIVE_INFINITY
			: args.length,
		options: (operation.options ?? []).map(
			(option): OptionSpec => ({
				name: flagOf(option.key),
				...(option.value === undefined ? {} : { value: option.value }),
				...(option.hidden ? { hidden: true } : {}),
				...(option.short === undefined ? {} : { short: option.short }),
			}),
		),
		summary: operation.summary,
	};
}

/** The JSON Schema type a property of `schema` takes, for reading a flag's text. */
function typeOf(schema: TObject, key: string): string | undefined {
	const property = (schema.properties as Record<string, TSchema>)[key] as
		| { type?: unknown }
		| undefined;
	return typeof property?.type === 'string' ? property.type : undefined;
}

/**
 * The input a command line gives `operation`: each positional and option
 * at its key, a number read as one, checked against the input schema; or
 * what is wrong, naming the flag or positional.
 */
export function inputOf(
	operation: Operation,
	positionals: readonly string[],
	options: Readonly<Record<string, string | true>>,
): Result<Record<string, unknown>, string> {
	const input: Record<string, unknown> = {};
	const names = new Map<string, string>();
	const args = operation.args ?? [];
	for (const [index, arg] of args.entries()) {
		names.set(arg.key, arg.label);
		if (arg.rest) {
			const rest = positionals.slice(index);
			if (rest.length > 0) input[arg.key] = rest;
			break;
		}
		const value = positionals[index];
		if (value !== undefined) input[arg.key] = value;
	}
	for (const option of operation.options ?? []) {
		const flag = `--${flagOf(option.key)}`;
		names.set(option.key, flag);
		const value = options[flagOf(option.key)];
		if (value === undefined) continue;
		const type = typeOf(operation.input, option.key);
		if (value === true) input[option.key] = true;
		else if (type === 'integer' || type === 'number') {
			const number = Number(value);
			input[option.key] = Number.isNaN(number) ? value : number;
		} else input[option.key] = value;
	}
	if (Value.Check(operation.input, input)) return Ok(input);
	const [first] = Value.Errors(operation.input, input);
	const key =
		first?.instancePath.split('/')[1] ??
		(first?.params as { requiredProperties?: string[] } | undefined)
			?.requiredProperties?.[0];
	const name = (key && names.get(key)) ?? key ?? 'the input';
	return Err(
		first?.keyword === 'required'
			? `${name} is needed`
			: `${name}: ${first?.message ?? 'not what the command takes'}`,
	);
}
