/** What Todos' desktop window names besides its roots. Only the desktop leaves import this. */
import { APPS } from '@epicenter/constants/apps';

/** Where Todos' web app publishes its contract (`static/contract.json`), which its sync names. */
export const CONTRACT_URL = `${APPS.TODOS.url}/contract.json`;
