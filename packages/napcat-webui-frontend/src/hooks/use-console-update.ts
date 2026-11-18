import { useRequest } from 'ahooks';
import ConsoleManager from '@/controllers/console_manager';
import { parseConsoleUpdate } from '@/utils/console-update';

/** Both views use the same authenticated check and treat failed refreshes as unknown. */
export default function useConsoleUpdate () {
  const request = useRequest(async () => parseConsoleUpdate(await ConsoleManager.checkUpdate()));
  return { ...request, data: request.error ? undefined : request.data };
}
