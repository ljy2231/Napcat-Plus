import { Button } from '@heroui/button';
import { LuActivity, LuArrowUpRight, LuBot, LuCable, LuClock3, LuFileText, LuFolderOpen, LuPackage, LuRefreshCw, LuShieldCheck, LuTriangleAlert } from 'react-icons/lu';
import { ConsoleVersionCard } from '@/components/console-update';
import { Link } from 'react-router-dom';
import { ApiError, ConsoleLoading, ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';
import useConsoleStatus from '@/hooks/use-console-status';
import { formatUptime, gscorePresentation, loginPresentation } from '@/utils/console';

const shortcuts = [
  { to: '/network', icon: LuCable, title: 'OneBot 连接', detail: 'HTTP、WebSocket 与事件上报' },
  { to: '/plugins', icon: LuPackage, title: '插件管理', detail: '配置与维护已安装插件' },
  { to: '/debug/ws', icon: LuActivity, title: '消息与调试', detail: '观察事件、聊天与接口测试' },
  { to: '/file_manager', icon: LuFolderOpen, title: '文件管理', detail: '浏览文件与上传资源' },
];

export default function DashboardIndexPage () {
  const { data, loading, error, refresh } = useConsoleStatus();
  // A cached response after a failed request is not proof of current availability.
  const current = error ? undefined : data;
  const login = loginPresentation(current?.login);
  const gs = gscorePresentation(current?.gscore.state);
  return <>
    <title>总览仪表盘 · Napcat-Plus</title>
    <ConsolePageHeader eyebrow='WORKSPACE OVERVIEW' title='总览仪表盘' description='连接状态、运行诊断与常用操作，在一个工作空间中掌握。' actions={<Button variant='bordered' size='sm' isLoading={loading} startContent={!loading && <LuRefreshCw size={15} />} onPress={refresh}>刷新状态</Button>} />
    {error && <ApiError error={error} onRetry={refresh} />}
    {loading && !data && <ConsoleLoading />}
    <div className='console-stat-grid'>
      <div className='console-stat'><div className='console-stat-heading'><span>QQ 账号状态</span><LuBot /></div><div className='console-stat-value'>{current ? login.label : '—'}</div><div className='console-stat-foot'><StatusBadge tone={current ? login.tone : 'neutral'}>{current?.login.coreReady ? '核心服务就绪' : current ? '等待核心就绪' : '状态待获取'}</StatusBadge></div></div>
      <div className='console-stat'><div className='console-stat-heading'><span>GSCore 连接</span><LuCable /></div><div className='console-stat-value'>{current ? gs.label : '—'}</div><div className='console-stat-foot'>{current ? (current.gscore.enabled ? `本轮重试 ${current.gscore.reconnectAttempts} 次` : '在连接管理中配置并启用') : '等待真实连接状态'}</div></div>
      <div className='console-stat'><div className='console-stat-heading'><span>本次运行时长</span><LuClock3 /></div><div className='console-stat-value'>{formatUptime(current?.uptime)}</div><div className='console-stat-foot'>服务端进程运行时间 · 每 5 秒更新</div></div>
      <ConsoleVersionCard fallbackVersion={current?.version} />
    </div>
    <div className='console-content-grid'>
      <div className='flex flex-col gap-5'>
        <ConsolePanel title='连接中心' description='仅展示当前 API 返回的状态，不使用模拟数据。' actions={<span className='console-live-label'><LuActivity size={13} />实时检查</span>}>
          <div className='console-service-row'>
            <span className='console-service-icon'><LuBot size={21} /></span>
            <div className='console-service-copy'><strong>QQ 登录服务</strong><p>{current ? login.detail : '尚未取得登录信息'}</p></div>
            <Link to='/qq_login' aria-label='查看 QQ 登录状态'><LuArrowUpRight className='text-default-500' size={19} /></Link>
          </div>
          <div className='console-service-row'>
            <span className='console-service-icon'><LuCable size={21} /></span>
            <div className='console-service-copy'><strong>GSCore 消息桥接</strong><p>{current?.gscore.enabled ? (current.gscore.lastError || current.gscore.url || '未配置连接地址') : '启用后将 QQ 消息对接到 GSCore'}</p></div>
            <StatusBadge tone={gs.tone}>{gs.label}</StatusBadge>
          </div>
          <div className='mt-4 flex flex-wrap gap-2'><Button as={Link} to='/gscore' size='sm' color='primary' endContent={<LuArrowUpRight />}>管理 GSCore</Button><Button as={Link} to='/qq_login' size='sm' variant='flat'>查看 QQ 登录</Button></div>
        </ConsolePanel>
        <ConsolePanel title='运行诊断' description='根据服务当前状态生成的诊断信息。' actions={<Link to='/logs' className='text-xs text-primary flex items-center gap-1'>查看日志<LuArrowUpRight /></Link>}>
          {!current ? <div className='console-empty'>等待服务响应后展示诊断结果。</div> : current.diagnostics.length === 0 ? <div className='console-empty'><LuShieldCheck className='mx-auto mb-2 text-success' size={24} />服务未报告诊断项目。<br />具体连接状态以上方实时结果为准。</div> : <div className='console-diagnostics'>{current.diagnostics.map((diagnostic, index) => <div className='console-diagnostic' key={`${diagnostic.title}-${index}`}>
            {diagnostic.level === 'info' ? <LuFileText className='text-primary shrink-0 mt-0.5' size={17} /> : <LuTriangleAlert className={`${diagnostic.level === 'error' ? 'text-danger' : 'text-warning'} shrink-0 mt-0.5`} size={17} />}
            <div><strong>{diagnostic.title}</strong><p>{diagnostic.detail}</p></div>
          </div>)}</div>}
        </ConsolePanel>
      </div>
      <div className='flex flex-col gap-5'>
        <ConsolePanel title='常用工作入口' description='原有功能全部保留，按任务快速直达。'><div className='console-quick-grid'>{shortcuts.map(({ to, icon: Icon, title, detail }) => <Link className='console-quick-link' key={to} to={to}><Icon size={19} /><strong>{title}</strong><p>{detail}</p></Link>)}</div></ConsolePanel>
        <ConsolePanel title='安全与维护' description='控制台会话与 QQ 账号登录相互独立。'>
          <div className='console-form-note'>退出管理登录不会让 QQ 下线。修改连接配置可能触发重新连接，请先确认地址和鉴权信息。设备、文件和终端操作仍通过原有功能提供。</div>
          <div className='mt-4 flex gap-4'><Link className='text-xs text-primary' to='/config'>系统设置 →</Link><Link className='text-xs text-primary' to='/about'>版本信息 →</Link></div>
        </ConsolePanel>
      </div>
    </div>
  </>;
}
