import { Button } from '@heroui/button';
import { LuArrowUpRight, LuBoxes, LuInfo } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import type { PluginStoreItem } from '@/types/plugin-store';
import { builtinPluginPath, pluginAvailabilityLabel, safePluginHomepage } from '@/utils/plugin-store';
import { StatusBadge } from '@/components/console-ui';

export type InstallStatus = 'not-installed' | 'installed' | 'update-available';
export interface PluginStoreCardProps {
  data: PluginStoreItem;
  onInstall?: () => void;
  onViewDetail?: () => void;
  installStatus?: InstallStatus;
  installedVersion?: string;
}

export default function PluginStoreCard ({ data, onViewDetail, installedVersion }: PluginStoreCardProps) {
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
      <p>{data.availability === 'builtin' ? '内置实现版本' : '目录记录版本'}：{data.version || '未记录'}</p>
      {installedVersion && <p>本机已安装：{installedVersion}（不自动判断更新）</p>}
      {data.availabilityReason && <p className='leading-relaxed'>{data.availabilityReason}</p>}
    </div>
    <div className='flex flex-wrap gap-2 pt-1'>
      {builtinPath ? <Button as={Link} to={builtinPath} color='primary' size='sm' endContent={<LuArrowUpRight />}>打开内置功能</Button> : homepage ? <Button as='a' href={homepage} target='_blank' rel='noopener noreferrer' variant='flat' size='sm' endContent={<LuArrowUpRight />}>前往项目主页</Button> : <Button size='sm' isDisabled>暂不可用</Button>}
      <Button size='sm' variant='light' startContent={<LuInfo />} onPress={onViewDetail}>来源说明</Button>
    </div>
  </section>;
}
