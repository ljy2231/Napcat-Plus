import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { LuRefreshCw, LuSearch, LuShieldCheck, LuTriangleAlert } from 'react-icons/lu';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import PluginManager, { type PluginItem } from '@/controllers/plugin_manager';
import type { PluginStoreItem, PluginStoreList } from '@/types/plugin-store';
import PluginStoreCard from '@/components/display_card/plugin_store_card';
import PluginDetailModal from '@/pages/dashboard/plugin_detail_modal';
import { ApiError, ConsoleLoading, ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';
import useDialog from '@/hooks/use-dialog';
import { cloudStoreItems, confirmedPlugins, installedStoreItems, pluginInstallStatus } from '@/utils/plugin-store';

const sourceLabels = { online: '云仓库可达', cached: '云目录缓存 · 仅浏览', bundled: '云目录尚未取得' };

export default function PluginStorePage () {
  const dialog = useDialog();
  const [catalog, setCatalog] = useState<PluginStoreList>();
  const [installed, setInstalled] = useState<PluginItem[] | null>(null);
  const [installedError, setInstalledError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [view, setView] = useState<'installed' | 'catalog' | 'builtin'>('installed');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const installBusy = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError(''); setInstalledError(''); setInstalled(null);
    try {
      const [store, local] = await Promise.allSettled([PluginManager.getPluginStoreList(refresh), PluginManager.getPluginList()]);
      if (!mounted.current) return;
      if (store.status === 'fulfilled') setCatalog(store.value);
      else setError(store.reason instanceof Error ? store.reason.message : '无法读取目录');
      const confirmed = local.status === 'fulfilled' ? confirmedPlugins(local.value) : null;
      setInstalled(confirmed);
      if (!confirmed) setInstalledError(local.status === 'fulfilled' && local.value?.pluginManagerNotFound
        ? '当前实例的插件管理器尚未就绪，无法确认安装状态；这不代表没有安装。预览与生产使用独立插件目录，不会自动同步插件。'
        : '无法获取已安装插件，安装状态未知。');
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  useEffect(() => {
    if (!catalog?.refreshing) return;
    const timer = setTimeout(() => { void load(); }, 4500);
    return () => clearTimeout(timer);
  }, [catalog, load]);
  const install = (plugin: PluginStoreItem) => {
    if (installBusy.current) return;
    installBusy.current = true;
    dialog.confirm({
      title: '确认从云端安装插件？',
      content: `将下载经本程序批准的 GitHub 固定发布包并校验 SHA-256。同 ID 插件已存在时不会覆盖；安装后默认禁用，不会自动执行；登记成功后可在插件管理中手动启用。第三方许可与安全性需自行确认。插件：${plugin.name}（${plugin.id}）${plugin.version ? ` · ${plugin.version}` : ''}`,
      confirmText: '确认安装',
      dismissible: false,
      onCancel: () => { installBusy.current = false; },
      onConfirm: async () => {
        setInstallingId(plugin.id);
        try {
          const result = await PluginManager.installFromStore(plugin.id);
          if (result.status === 'registered') toast.success(`${plugin.name} 安装完成，已登记并默认禁用`);
          else if (result.status === 'restart_required') toast(`${plugin.name} 文件已安装，需重启后显示`);
          else toast.error(`${plugin.name} 文件已安装，但插件管理器登记失败；请检查日志和插件限制`);
          await load(true);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '安装失败');
        } finally {
          installBusy.current = false;
          if (mounted.current) setInstallingId(null);
        }
      },
    });
  };
  const items = useMemo(() => view === 'installed' ? installedStoreItems(catalog?.plugins || [], installed) : view === 'builtin' ? (catalog?.plugins || []).filter(item => item.availability === 'builtin') : cloudStoreItems(catalog), [catalog, installed, view]);
  const selected = items.find(item => item.id === (selectedId || params.get('pluginId'))) || null;
  const filtered = useMemo(() => items.filter(item => {
    const haystack = `${item.name} ${item.id} ${item.description} ${item.author} ${(item.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase()) && (filter === 'all' || item.availability === filter);
  }), [items, search, filter]);
  const sourceStatus = catalog?.sourceStatus || 'bundled';
  const installedVersion = (item: PluginStoreItem) => installed?.find(p => p.id === item.id)?.version;
  return <>
    <title>插件商店 · Napcat-Plus</title>
    <ConsolePageHeader eyebrow='PLUGIN DIRECTORY' title='插件商店' description='浏览已安装插件或云端目录；目录信息仅供参考，安装前请自行确认来源与许可。' actions={<Button size='sm' variant='bordered' isLoading={loading} onPress={() => { void load(true); }} startContent={!loading && <LuRefreshCw />}>检查目录</Button>} />
    {error && <ApiError error={new Error(error)} onRetry={() => { void load(); }} />}
    <ConsolePanel title='目录状态' actions={<StatusBadge tone={sourceStatus === 'online' ? 'success' : 'warning'}>{sourceLabels[sourceStatus]}</StatusBadge>}>
      <div className='flex gap-3'><LuTriangleAlert className='text-warning shrink-0 mt-0.5' size={19} /><div className='text-sm space-y-2'>
        <p>{catalog?.sourceMessage || '正在读取本地目录与来源状态。'}</p>
        <p className='text-default-500'>仅允许安装本程序批准的固定版本并校验 SHA-256；不会覆盖已有插件，也不会自动执行。第三方许可与安全性需自行确认，历史缓存只供浏览。</p>
        {catalog?.refreshing && <p className='text-primary' role='status'>正在后台检查原始来源，页面仍可使用…</p>}
        {catalog?.checkedAt && <p className='text-xs text-default-500'>最近检查：{new Date(catalog.checkedAt).toLocaleString()}</p>}
        {catalog?.lastSuccessAt && <p className='text-xs text-default-500'>最近成功：{new Date(catalog.lastSuccessAt).toLocaleString()}</p>}
      </div></div>
    </ConsolePanel>
    <div className='mt-5 flex gap-2' role='group' aria-label='插件商店入口'>
      {([['installed', '已安装'], ['catalog', '云端目录'], ['builtin', '内置功能']] as const).map(([value, label]) => <Button key={value} size='sm' variant={view === value ? 'solid' : 'flat'} color={view === value ? 'primary' : 'default'} aria-pressed={view === value} onPress={() => { setView(value); setFilter('all'); setSelectedId(null); }}>{label}</Button>)}
    </div>
    <div className='my-5 flex flex-col sm:flex-row gap-3 justify-between'>
      <Input aria-label='搜索插件目录' placeholder='搜索名称、作者或标签' value={search} onValueChange={setSearch} startContent={<LuSearch />} isClearable className='sm:max-w-sm' />
      <div className='flex gap-2 flex-wrap' role='group' aria-label='目录类别'>{[['all', '全部'], ['installable', '可安装'], ['unavailable', '暂不可用'], ['local', '仅本地']].map(([value, label]) => <Button key={value} size='sm' variant={filter === value ? 'solid' : 'flat'} color={filter === value ? 'primary' : 'default'} aria-pressed={filter === value} onPress={() => setFilter(value)}>{label}</Button>)}</div>
    </div>
    {loading ? <ConsoleLoading /> : <div className='grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'>{filtered.map(plugin => <PluginStoreCard key={plugin.id} data={plugin} installStatus={pluginInstallStatus(plugin.id, installed)} installedVersion={installedVersion(plugin)} onInstall={() => install(plugin)} isInstalling={installingId === plugin.id} onViewDetail={() => setSelectedId(plugin.id)} />)}</div>}
    {!loading && !filtered.length && <p className='console-empty'>{view === 'installed' && installed === null ? '无法确认已安装插件，请重试或查看云端目录。' : view === 'installed' ? '没有匹配的已安装插件。' : '没有匹配的云来源目录条目。'}</p>}
    <div className='mt-5 console-form-note flex gap-2'><LuShieldCheck className='shrink-0 mt-0.5' /><div>已有插件仍在本地独立运行。{installedError || '查看启用状态和配置请前往插件管理。'} <Link className='text-primary' to='/plugins'>打开插件管理 →</Link></div></div>
    <PluginDetailModal isOpen={!!selected} onClose={() => { setSelectedId(null); if (params.has('pluginId')) { const next = new URLSearchParams(params); next.delete('pluginId'); setParams(next); } }} plugin={selected} installStatus={selected ? pluginInstallStatus(selected.id, installed) : 'unknown'} installedVersion={selected ? installedVersion(selected) : undefined} onInstall={selected ? () => install(selected) : undefined} isInstalling={!!selected && installingId === selected.id} />
  </>;
}
