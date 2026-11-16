import { useRequest } from 'ahooks';
import ConsoleManager from '@/controllers/console_manager';

/** Poll only while visible. A failed refresh must never masquerade as "online". */
export default function useConsoleStatus () {
  return useRequest(ConsoleManager.getStatus, {
    pollingInterval: 5000,
    pollingWhenHidden: false,
    loadingDelay: 150,
  });
}
