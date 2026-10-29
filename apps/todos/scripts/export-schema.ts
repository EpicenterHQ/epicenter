/** Export the app's own TypeBox schemas without opening a data folder. */
import { exportTables } from '@epicenter/folder/declaration';
import { todosTables } from '../src/definition.js';

const result = exportTables(todosTables);
if (result.error !== null) throw new Error(result.error.reason);
await Bun.write(Bun.stdout, `${JSON.stringify(result.data, null, 2)}\n`);
