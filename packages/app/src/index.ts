import { isAppId } from '@epicenter/constants/app-id';
import type { DeclaredTable } from './data/definition/declaration.js';
import type { ValidateFields } from './data/definition/define.js';
import { compileData, type DataDefinition } from './data/definition/index.js';

/** Declare and validate a platform-free schema. Opening belongs to @epicenter/app/open. */
export function defineApp<const TDefinition extends DataDefinition>(
	schema: TDefinition & {
		kv: ValidateFields<TDefinition['kv']>;
		tables: {
			[Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends DeclaredTable
				? TDefinition['tables'][Name]
				: DeclaredTable;
		};
	} & Record<Exclude<keyof TDefinition, keyof DataDefinition>, never>,
) {
	type Definition = Pick<
		TDefinition & Pick<DataDefinition, 'title'>,
		'id' | 'title' | 'kv' | 'tables'
	>;
	const { id, title, kv, tables } = schema;
	if (!isAppId(id)) throw new Error(`The application id '${id}' is not valid.`);
	const declaration: Definition = Object.freeze({
		id,
		...(title === undefined ? {} : { title }),
		kv,
		tables,
	});
	const compiled = compileData(declaration);
	if (compiled.error !== null)
		throw new Error(compiled.error.message, { cause: compiled.error });
	return declaration;
}

export { plainText } from './data/definition/content.js';
export {
	type ContentCodec,
	ContentError,
	type CreateRowOf,
	type DataDefinition,
	field,
	type KvOf,
	type RowOf,
} from './data/definition/declaration.js';
export { defineTable } from './data/definition/define.js';
export type { JsonObject, JsonValue } from './data/definition/json.js';
export { jsonValue } from './data/field/index.js';
