import { Button } from '@heroui/button';
import { Checkbox } from '@heroui/checkbox';
import { Input } from '@heroui/input';
import { Switch } from '@heroui/switch';
import { useRequest } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { LuArrowUpRight, LuBrush, LuCable, LuMessageSquare, LuRefreshCw, LuShieldCheck, LuTrash2, LuWrench } from 'react-icons/lu';
import { ApiError, ConsoleLoading, ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';
import PluginManager, { type PluginItem } from '@/controllers/plugin_manager';
import ToolsManager, { type CleanupCategory, type CleanupPreview, type CleanupResult } from '@/controllers/tools_manager';
import useDialog from '@/hooks/use-dialog';
import { cleanupInputError, formatBytes, previewExpiry } from '@/utils/tools';

function CacheCleaner () {
  const dialog = useDialog();
  const [categories, setCategories] = useState<CleanupCategory[]>(['logs']);
  const [days, setDays] = useState(7);
  const [preview, setPreview] = useState<CleanupPreview>();
  const [result, setResult] = useState<CleanupResult>();
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  useEffect(() => { if (!preview) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [preview]);
  const invalidate = () => { generation.current++; setPreview(undefined); setResult(undefined); setError(''); };
  const previewIsExpired = !!preview && now >= previewExpiry(preview.expiresAt);
  const getPreview = async () => {
    const message = cleanupInputError(categories, days);
    if (message) { setError(message); return; }
    const version = ++generation.current;
    setLoading(true); setError(''); setPreview(undefined); setResult(undefined);
    try { const value = await ToolsManager.previewCleanup(categories, days); if (version === generation.current) { setNow(Date.now()); setPreview(value); } }
    catch (cause) { if (version === generation.current) setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  const execute = () => {
    if (!preview || previewIsExpired || !preview.count || executing) return;
    const snapshot = preview;
    const version = generation.current;
    dialog.confirm({ title: '确认删除预览中的文件？', content: `将永久删除预览确认的 ${snapshot.count} 个 NapCat 日志/缓存文件，预计 ${formatBytes(snapshot.totalBytes)}。不会清理 QQ 数据库或账号媒体。此操作不可撤销。`, confirmText: '确认删除', onConfirm: async () => {
      if (version !== generation.current || Date.now() >= previewExpiry(snapshot.expiresAt)) { setError('预览已过期或条件已改变，请重新生成预览。'); return; }
      setExecuting(true); setError('');
      try { const value = await ToolsManager.executeCleanup(snapshot.previewId); setResult(value); setPreview(undefined); toast.success('清理操作已完成'); }
      catch (cause) { setError((cause as Error).message); setPreview(undefined); }
      finally { setExecuting(false); }
    } });
  };
  return <ConsolePanel title='日志与缓存清理' description='默认不自动清理。先预览，再由你明确确认执行。' actions={<LuBrush className='text-primary' size={21} />}>
    <div className='console-form-note mb-5'>范围仅限 NapCat 的 <code>logs</code> 和 <code>cache</code>。不扫描 QQ 聊天数据库、账号目录、媒体文件或插件配置。服务端会再次验证预览与文件范围。</div>
    <div className='flex flex-col gap-5'>
      <div className='flex flex-wrap gap-5'>
        {(['logs', 'cache'] as const).map((category) => <Checkbox key={category} size='sm' isDisabled={executing || loading} isSelected={categories.includes(category)} onValueChange={(checked) => { invalidate(); setCategories((value) => checked ? [...value, category] : value.filter((item) => item !== category)); }}>{category === 'logs' ? '运行日志' : '临时缓存'}</Checkbox>)}
      </div>
      <Input className='max-w-xs' type='number' label='仅清理多少天以前的文件' labelPlacement='outside' variant='bordered' value={String(days)} min={1} max={3650} step={1} onValueChange={(value) => { invalidate(); setDays(Number(value)); }} isDisabled={executing || loading} description='1–3650 天；新文件不会列入预览。' />
      <div><Button size='sm' variant='flat' color='primary' isLoading={loading} isDisabled={executing} onPress={getPreview} startContent={!loading && <LuRefreshCw />}>生成清理预览</Button></div>
      {error && <p className='text-xs text-danger leading-relaxed' role='alert'>{error}</p>}
      {preview && <div className='rounded-xl border border-divider overflow-hidden'>
        <div className='flex flex-wrap justify-between items-center gap-3 p-4 bg-default-50'><div><strong className='text-sm'>{preview.count} 个文件 · {formatBytes(preview.totalBytes)}</strong><p className='text-xs text-default-500 mt-1'>{previewIsExpired ? '预览已过期，请重新生成。' : `预览有效至 ${new Date(previewExpiry(preview.expiresAt)).toLocaleTimeString('zh-CN')}`}</p></div><StatusBadge tone={previewIsExpired ? 'warning' : 'neutral'}>{previewIsExpired ? '已过期' : '尚未删除'}</StatusBadge></div>
        {preview.files.length > 0 ? <div className='overflow-x-auto max-h-72'><table className='w-full text-xs text-left'><thead className='sticky top-0 bg-content1'><tr className='border-b border-divider'><th scope='col' className='p-3 font-medium'>文件</th><th scope='col' className='p-3 font-medium'>类别</th><th scope='col' className='p-3 font-medium text-right'>大小</th></tr></thead><tbody>{preview.files.map((file, index) => <tr key={`${file.category}/${file.name}/${index}`} className='border-b border-divider last:border-0'><td className='p-3 break-all min-w-40'>{file.name}</td><td className='p-3'>{file.category}</td><td className='p-3 whitespace-nowrap text-right'>{formatBytes(file.size)}</td></tr>)}</tbody></table></div> : <div className='p-5 text-center text-xs text-default-500'>没有符合清理条件的文件。</div>}
        {preview.truncated && <p className='p-3 text-xs text-warning'>文件列表已截断，实际确认范围为上方服务端返回的总数。若不确定，请缩小类别或增加保留天数。</p>}
        <div className='p-4 border-t border-divider flex justify-end'><Button size='sm' color='danger' variant='flat' startContent={!executing && <LuTrash2 />} isLoading={executing} isDisabled={!preview.count || previewIsExpired} onPress={execute}>确认清理…</Button></div>
      </div>}
      {result && <div className='console-form-note' role='status'><strong>清理完成</strong><br />删除 {result.deleted} 个，跳过 {result.skipped} 个，释放 {formatBytes(result.bytes)}。未通过服务端复验的文件会跳过。</div>}
    </div>
  </ConsolePanel>;
}

function PluginDiagnostics () {
  const dialog = useDialog();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<string>();
  const request = useRequest(PluginManager.getPluginList, { manual: true });
  const visible = enabled && !request.error ? request.data : undefined;
  const action = (plugin: PluginItem, reload: boolean) => {
    dialog.confirm({
      title: reload ? `重新加载 ${plugin.name}？` : `${plugin.status === 'active' ? '停用' : '启用'} ${plugin.name}？`,
      content: reload ? '会调用插件的清理与初始化流程，可能短暂中断该插件服务。请确保没有关键任务正在运行。' : '修改插件状态会立即影响该插件的消息处理和后台任务。不会重启 QQ 主进程。',
      confirmText: '确认操作',
      onConfirm: async () => {
        setBusy(plugin.id);
        try { if (reload) await ToolsManager.reloadPlugin(plugin.id); else await PluginManager.setPluginStatus(plugin.id, plugin.status !== 'active'); toast.success('插件操作已完成'); await request.runAsync(); }
        catch (cause) { toast.error((cause as Error).message); }
        finally { setBusy(undefined); }
      },
    });
  };
  return <ConsolePanel title='插件诊断与重载' description='默认收起。仅通过现有鉴权接口执行明确的单次操作。' actions={<LuWrench className='text-primary' size={20} />}>
    <div className='flex justify-between items-center gap-4'><p className='text-xs text-default-500 leading-relaxed'>打开诊断面板不会自动启用、停用或重载任何插件。</p><Switch aria-label='打开插件诊断面板' isSelected={enabled} isDisabled={!!busy} onValueChange={(value) => { setEnabled(value); if (value) request.run(); }} /></div>
    {enabled && <div className='mt-5'>
      {request.error && <ApiError error={request.error} onRetry={request.run} />}
      {request.loading && !request.data ? <ConsoleLoading label='正在读取插件列表…' /> : visible?.pluginManagerNotFound ? <div className='console-empty'>插件管理器尚未就绪。通常需要 QQ 登录成功后才能加载插件。</div> : visible?.plugins.length === 0 ? <div className='console-empty'>当前没有已发现的插件。</div> : visible?.plugins.map((plugin) => <div key={plugin.id} className='console-service-row !items-start'>
        <div className='console-service-copy'><strong>{plugin.name} <span className='text-[10px] text-default-400 font-normal'>v{plugin.version}</span></strong><p>{plugin.id}</p><div className='mt-2'><StatusBadge tone={plugin.status === 'active' ? 'success' : 'neutral'}>{plugin.status === 'active' ? '运行中' : plugin.status === 'disabled' ? '已禁用' : '已停止'}</StatusBadge></div></div>
        <div className='flex flex-col gap-2'><Button size='sm' variant='flat' isLoading={busy === plugin.id} isDisabled={!!busy} onPress={() => action(plugin, false)}>{plugin.status === 'active' ? '停用' : '启用'}</Button><Button size='sm' variant='bordered' isDisabled={!!busy || plugin.status !== 'active'} onPress={() => action(plugin, true)}>重载…</Button></div>
      </div>)}
      <Button variant='light' size='sm' onPress={request.run} isLoading={request.loading} isDisabled={!!busy} startContent={<LuRefreshCw />}>刷新列表</Button>
    </div>}
  </ConsolePanel>;
}

export default function ToolsPage () {
  return <>
    <title>内置工具 · QQ Bot Console</title>
    <ConsolePageHeader eyebrow='BUILT-IN UTILITIES' title='内置工具' description='常用能力直接可达。清理与插件操作默认不自动执行，由你掌控。' />
    <div className='console-content-grid'>
      <div className='flex flex-col gap-5'><CacheCleaner /><PluginDiagnostics /></div>
      <div className='flex flex-col gap-5'>
        <ConsolePanel title='消息与聊天' description='使用保留的 OneBot 实时调试与消息能力。' actions={<LuMessageSquare className='text-primary' size={21} />}>
          <p className='text-xs text-default-500 leading-relaxed'>查看实时消息事件、测试发送与回复，沿用原有 OneBot 聊天组件。连接后才会出现真实事件，不预填模拟聊天记录。</p>
          <Button as={Link} to='/debug/ws' color='primary' className='w-full mt-5' endContent={<LuArrowUpRight />}>打开消息与聊天</Button>
          <p className='text-[11px] text-default-400 mt-3 leading-relaxed'>已安装插件的自定义聊天页仍可从「扩展页面」进入。本页不声称已打包第三方 SSQQ 客户端。</p>
        </ConsolePanel>
        <ConsolePanel title='GSCore 原生连接' description='无需额外安装适配器即可配置原生桥接。' actions={<LuCable className='text-primary' size={21} />}><p className='text-xs text-default-500 leading-relaxed'>连接地址、Token、重试策略和实时状态集中管理。未启用时不连接、不转发。</p><Button as={Link} to='/gscore' variant='flat' className='w-full mt-5' endContent={<LuArrowUpRight />}>管理 GSCore</Button></ConsolePanel>
        <div className='console-form-note'><div className='flex items-center gap-2 mb-2 font-semibold'><LuShieldCheck />安全边界</div>没有默认自动清理任务，没有未鉴权的调试端口，也不提供任意脚本执行入口。危险操作需要确认；插件终端等原有高级功能仍受原鉴权保护。</div>
      </div>
    </div>
  </>;
}
