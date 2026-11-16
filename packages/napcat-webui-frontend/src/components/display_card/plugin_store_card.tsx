import { Button } from '@heroui/button';
import { LuArrowUpRight, LuBoxes, LuInfo } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import type { PluginStoreItem } from '@/types/plugin-store';
import { builtinPluginPath, pluginAvailabilityLabel, safePluginHomepage, type InstallStatus } from '@/utils/plugin-store';
import { StatusBadge } from '@/components/console-ui';

export interface PluginStoreCardProps {
  data: PluginStoreItem;
  onInstall?: () => void;
  onViewDetail?: () => void;
  installStatus?: InstallStatus;
  installedVersion?: string;
  isInstalling?: boolean;
}

export default function PluginStoreCard ({ data, onInstall, onViewDetail, installedVersion, installStatus = 'unknown', isInstalling = false }: PluginStoreCardProps) {
  const builtinPath = builtinPluginPath(data);
  const homepage = safePluginHomepage(data.homepage);
  return <section className='console-panel flex flex-col gap-4 p-5 h-full'>
    <div className='flex items-start justify-between gap-3'>
      <span className='console-service-icon shrink-0'><LuBoxes size={21} /></span>
      <StatusBadge tone={data.availability === 'builtin' ? 'success' : 'neutral'}>{pluginAvailabilityLabel(data)}</StatusBadge>
    </div>
    <div><h2 className='font-semibold text-base'>{data.name}</h2><p className='text-xs text-default-500 mt-1'>{data.author || '来源未标注'}</p></div>
    <p className='text-sm text-default-600 leading-relaxed flex-1'>{data.description}</p>
    <div className='text-xs space-y-2 text-default-500'>
      {data.availability !== 'local' && <p>{data.availability === 'builtin' ? '内置实现版本' : '目录记录版本'}：{data.version || '未记录'}</p>}
      {data.availability !== 'builtin' && <p>安装状态：{installStatus === 'unknown' ? '未知' : installStatus === 'installed' ? '已安装' : '未安装'}{installStatus === 'installed' && installedVersion ? `（本机版本：${installedVersion}）` : ''}</p>}
      {data.availabilityReason && <p className='leading-relaxed'>{data.availabilityReason}</p>}
    </div>
    <div className='flex flex-wrap gap-2 pt-1'>
      {data.availability === 'installable' && installStatus !== 'installed' && <Button color='primary' size='sm' isLoading={isInstalling} isDisabled={isInstalling || installStatus === 'unknown'} onPress={onInstall}>{isInstalling ? '安装中' : '安装'}</Button>}
      {builtinPath ? <Button as={Link} to={builtinPath} color='primary' size='sm' endContent={<LuArrowUpRight />}>打开内置功能</Button> : homepage ? <Button as='a' href={homepage} target='_blank' rel='noopener noreferrer' variant='flat' size='sm' endContent={<LuArrowUpRight />}>前往项目主页</Button> : data.availability === 'installable' ? null : <Button size='sm' isDisabled>暂不可用</Button>}
      <Button size='sm' variant='light' startContent={<LuInfo />} onPress={onViewDetail}>来源说明</Button>
    </div>
  </section>;
}
