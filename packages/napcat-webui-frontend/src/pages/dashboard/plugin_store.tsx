import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { LuRefreshCw, LuSearch, LuShieldCheck, LuTriangleAlert } from 'react-icons/lu';
import { Link, useSearchParams } from 'react-router-dom';
import PluginManager, { type PluginItem } from '@/controllers/plugin_manager';
import type { PluginStoreItem, PluginStoreList } from '@/types/plugin-store';
import PluginStoreCard from '@/components/display_card/plugin_store_card';
import PluginDetailModal from '@/pages/dashboard/plugin_detail_modal';
import { ApiError, ConsoleLoading, ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';

const sourceLabels = { online: '上游目录可达', cached: '历史缓存 · 仅浏览', bundled: '随版本提供的目录' };

export default function PluginStorePage () {
  const [catalog, setCatalog] = useState<PluginStoreList>();
  const [installed, setInstalled] = useState<PluginItem[]>([]);
  const [installedError, setInstalledError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<PluginStoreItem | null>(null);
  const [params, setParams] = useSearchParams();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const load = useCallback(async (refresh = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError(''); setInstalledError('');
    try {
      const [store, local] = await Promise.allSettled([PluginManager.getPluginStoreList(refresh), PluginManager.getPluginList()]);
      if (!mounted.current) return;
      if (store.status === 'fulfilled') setCatalog(store.value);
      else setError(store.reason instanceof Error ? store.reason.message : '无法读取目录');
      if (local.status === 'fulfilled') setInstalled(local.value.plugins || []);
      else setInstalledError('暂时无法获取已安装插件；不会影响目录浏览。');
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
  useEffect(() => {
    const id = params.get('pluginId');
    if (id && catalog) setSelected(catalog.plugins.find(item => item.id === id) || null);
  }, [params, catalog]);
  const filtered = useMemo(() => (catalog?.plugins || []).filter(item => {
    const haystack = `${item.name} ${item.id} ${item.description} ${item.author} ${(item.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase()) && (filter === 'all' || item.availability === filter);
  }), [catalog, search, filter]);
  const sourceStatus = catalog?.sourceStatus || 'bundled';
  const installedVersion = (item: PluginStoreItem) => installed.find(p => p.id === item.id)?.version;
  return <>
    <title>插件商店 · Napcat-Plus</title>
    <ConsolePageHeader eyebrow='PLUGIN DIRECTORY' title='插件商店' description='浏览来源明确的目录、打开内置功能，或前往第三方项目。上游删库不再让整个页面失效。' actions={<Button size='sm' variant='bordered' isLoading={loading} onPress={() => { void load(true); }} startContent={!loading && <LuRefreshCw />}>检查目录</Button>} />
    {error && <ApiError error={new Error(error)} onRetry={() => { void load(); }} />}
    <ConsolePanel title='目录状态' actions={<StatusBadge tone={sourceStatus === 'online' ? 'success' : 'warning'}>{sourceLabels[sourceStatus]}</StatusBadge>}>
      <div className='flex gap-3'><LuTriangleAlert className='text-warning shrink-0 mt-0.5' size={19} /><div className='text-sm space-y-2'>
        <p>{catalog?.sourceMessage || '正在读取本地目录与来源状态。'}</p>
        <p className='text-default-500'>远程一键安装暂时停用。内置功能无需下载；外部项目请在原作者页面核对版本与许可后自行安装。历史缓存只供浏览，不作为下载信任依据。</p>
        {catalog?.refreshing && <p className='text-primary' role='status'>正在后台检查原始来源，页面仍可使用…</p>}
        {catalog?.checkedAt && <p className='text-xs text-default-500'>最近检查：{new Date(catalog.checkedAt).toLocaleString()}</p>}
        {catalog?.lastSuccessAt && <p className='text-xs text-default-500'>最近成功：{new Date(catalog.lastSuccessAt).toLocaleString()}</p>}
      </div></div>
    </ConsolePanel>
    <div className='my-5 flex flex-col sm:flex-row gap-3 justify-between'>
      <Input aria-label='搜索插件目录' placeholder='搜索名称、作者或标签' value={search} onValueChange={setSearch} startContent={<LuSearch />} isClearable className='sm:max-w-sm' />
      <div className='flex gap-2 flex-wrap' role='group' aria-label='目录类别'>{[['all', '全部'], ['builtin', '内置功能'], ['external', '外部项目'], ['unavailable', '暂不可用']].map(([value, label]) => <Button key={value} size='sm' variant={filter === value ? 'solid' : 'flat'} color={filter === value ? 'primary' : 'default'} aria-pressed={filter === value} onPress={() => setFilter(value)}>{label}</Button>)}</div>
    </div>
    {loading && !catalog ? <ConsoleLoading /> : <div className='grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4'>{filtered.map(plugin => <PluginStoreCard key={plugin.id} data={plugin} installedVersion={installedVersion(plugin)} onViewDetail={() => setSelected(plugin)} />)}</div>}
    {!loading && !filtered.length && <p className='console-empty'>没有匹配的目录项目。</p>}
    <div className='mt-5 console-form-note flex gap-2'><LuShieldCheck className='shrink-0 mt-0.5' /><div>已有插件仍在本地独立运行。{installedError || '查看启用状态和配置请前往插件管理。'} <Link className='text-primary' to='/plugins'>打开插件管理 →</Link></div></div>
    <PluginDetailModal isOpen={!!selected} onClose={() => { setSelected(null); if (params.has('pluginId')) { const next = new URLSearchParams(params); next.delete('pluginId'); setParams(next); } }} plugin={selected} installedVersion={selected ? installedVersion(selected) : undefined} />
  </>;
}
