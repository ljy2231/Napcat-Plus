import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/modal';
import { Button } from '@heroui/button';
import { Link } from 'react-router-dom';
import type { PluginStoreItem } from '@/types/plugin-store';
import { builtinPluginPath, pluginAvailabilityLabel, safePluginHomepage, type InstallStatus } from '@/utils/plugin-store';

interface PluginDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  plugin: PluginStoreItem | null;
  installStatus?: InstallStatus;
  installedVersion?: string;
  onInstall?: () => void;
  isInstalling?: boolean;
}

export default function PluginDetailModal ({ isOpen, onClose, plugin, installedVersion, installStatus = 'unknown', onInstall, isInstalling = false }: PluginDetailModalProps) {
  if (!plugin) return null;
  const homepage = safePluginHomepage(plugin.homepage);
  const sourceUrl = safePluginHomepage(plugin.sourceUrl);
  const builtinPath = builtinPluginPath(plugin);
  return <Modal isOpen={isOpen} onClose={onClose} size='2xl' scrollBehavior='inside'>
    <ModalContent>
      <ModalHeader>{plugin.name} · 来源说明</ModalHeader>
      <ModalBody className='gap-4 text-sm'>
        <p className='leading-relaxed'>{plugin.description}</p>
        <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-3'>
          <dt className='text-default-500'>状态</dt><dd>{pluginAvailabilityLabel(plugin)}</dd>
          <dt className='text-default-500'>插件 ID</dt><dd className='font-mono break-all'>{plugin.id}</dd>
          {plugin.availability !== 'local' && <><dt className='text-default-500'>目录版本</dt><dd>{plugin.version || '未记录'}（不代表最新）</dd></>}
          {plugin.availability !== 'builtin' && <><dt className='text-default-500'>安装状态</dt><dd>{installStatus === 'unknown' ? '未知' : installStatus === 'installed' ? '已安装' : '未安装'}</dd></>}
          {installStatus === 'installed' && installedVersion && <><dt className='text-default-500'>本机版本</dt><dd>{installedVersion}</dd></>}
          <dt className='text-default-500'>作者</dt><dd>{plugin.author || '未标注'}</dd>
          <dt className='text-default-500'>目录来源</dt><dd>{plugin.sourceName || '服务端目录'}</dd>
        </dl>
        {plugin.availabilityReason && <p className='console-form-note'>{plugin.availabilityReason}</p>}
        <p className='console-form-note'>只允许安装本程序批准的固定版本，并校验 SHA-256；不会覆盖同 ID 插件，也不会自动执行。第三方插件的许可与安全性需自行确认。</p>
        {sourceUrl && <a href={sourceUrl} target='_blank' rel='noopener noreferrer' className='text-primary break-all'>查看来源页面 →</a>}
      </ModalBody>
      <ModalFooter>
        <Button variant='light' onPress={onClose}>关闭</Button>
        {plugin.availability === 'installable' && installStatus !== 'installed' && <Button color='primary' isLoading={isInstalling} isDisabled={isInstalling || installStatus === 'unknown'} onPress={onInstall}>{isInstalling ? '安装中' : '安装'}</Button>}
        {builtinPath ? <Button as={Link} to={builtinPath} color='primary' onPress={onClose}>打开内置功能</Button> : homepage ? <Button as='a' href={homepage} target='_blank' rel='noopener noreferrer' color='primary'>前往项目主页</Button> : null}
      </ModalFooter>
    </ModalContent>
  </Modal>;
}
