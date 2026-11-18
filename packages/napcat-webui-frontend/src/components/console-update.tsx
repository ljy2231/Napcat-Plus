import { Button } from '@heroui/button';
import { Link } from 'react-router-dom';
import useConsoleUpdate from '@/hooks/use-console-update';
import { consoleUpdateLabel } from '@/utils/console-update';

export function ConsoleVersionCard ({ fallbackVersion }: { fallbackVersion?: string }) {
  const { data, loading, error } = useConsoleUpdate();
  const available = !loading && !error && data?.status === 'available';
  return <div className='console-stat console-version-card'>
    <div className='console-stat-heading'><span>当前版本</span><Link to='/about' className='text-primary' aria-label='查看版本信息'>版本信息 →</Link></div>
    <div className='console-version-values'>
      <div className='min-w-0'>
        {available && <span className='console-version-alert'>有新版本！</span>}
        <div className='console-stat-value'>{data?.currentVersion || fallbackVersion || '—'}</div>
      </div>
      {available && <div className='console-version-latest'><span>最新版本</span><strong>{data.latestVersion}</strong></div>}
    </div>
    <div className='console-stat-foot console-version-foot'><span>Napcat-Plus</span><span role='status'>{consoleUpdateLabel(data, loading, error)}</span></div>
  </div>;
}

export function ConsoleUpdatePanel () {
  const { data, loading, error, refresh } = useConsoleUpdate();
  const available = !loading && !error && data?.status === 'available';
  return <section aria-labelledby='console-update-title' className='rounded-xl bg-default-100/50 p-4 space-y-3'>
    <h2 id='console-update-title' className='text-lg font-bold'>Napcat-Plus 版本检查</h2>
    <div role='status' className='text-sm'>{consoleUpdateLabel(data, loading, error)}</div>
    <div className='flex flex-wrap gap-x-6 gap-y-2 text-sm'>
      <span>当前版本：<strong className='break-all'>{data?.currentVersion || '未知'}</strong></span>
      <span>最新版本：<strong className='break-all'>{!error && data?.latestVersion || '未知'}</strong></span>
    </div>
    <div className='flex flex-wrap gap-2'>
      <Button size='sm' variant='bordered' isLoading={loading} onPress={refresh}>重新检查</Button>
      {available && data.releaseUrl && <a className='text-sm text-primary underline self-center' href={data.releaseUrl} target='_blank' rel='noopener noreferrer'>查看版本发布说明（新窗口）</a>}
    </div>
  </section>;
}
