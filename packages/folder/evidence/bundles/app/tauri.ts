/** An application that names the desktop entry itself. */
import { openFolder } from '@epicenter/folder/tauri';

export const start = () => openFolder({ tables: {} });
