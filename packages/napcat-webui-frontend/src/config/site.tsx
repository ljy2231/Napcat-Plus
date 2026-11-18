import {
  LuActivity,
  LuFileText,
  LuFolderOpen,
  LuInfo,
  LuLayoutDashboard,
  LuLogIn,
  LuSettings,
  LuSignal,
  LuTerminal,
  LuZap,
  LuPackage,
  LuStore,
  LuPuzzle,
  LuCable,
  LuWrench,
} from 'react-icons/lu';

export type SiteConfig = typeof siteConfig;
export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  autoOpen?: boolean;
  href?: string;
  items?: MenuItem[];
  customIcon?: string;
}

export const siteConfig = {
  name: 'Napcat-Plus',
  description: '中文优先的 QQ 机器人管理控制台。',
  navItems: [
    {
      label: '总览仪表盘',
      icon: <LuLayoutDashboard className='w-5 h-5' />,
      href: '/',
    },
    {
      label: 'GSCore 连接',
      icon: <LuCable className='w-5 h-5' />,
      href: '/gscore',
    },
    {
      label: '内置工具',
      icon: <LuWrench className='w-5 h-5' />,
      href: '/tools',
    },
    {
      label: 'QQ 登录',
      icon: <LuLogIn className='w-5 h-5' />,
      href: '/qq_login',
    },
    {
      label: 'OneBot 连接',
      icon: <LuSignal className='w-5 h-5' />,
      href: '/network',
    },
    {
      label: '运行日志',
      icon: <LuFileText className='w-5 h-5' />,
      href: '/logs',
    },
    {
      label: '接口调试',
      icon: <LuActivity className='w-5 h-5' />,
      href: '/debug/http',
    },
    {
      label: '实时调试',
      icon: <LuZap className='w-5 h-5' />,
      href: '/debug/ws',
    },
    {
      label: '文件管理',
      icon: <LuFolderOpen className='w-5 h-5' />,
      href: '/file_manager',
    },
    {
      label: '插件管理',
      icon: <LuPackage className='w-5 h-5' />,
      href: '/plugins',
    },
    {
      label: '插件商店',
      icon: <LuStore className='w-5 h-5' />,
      href: '/plugin_store',
    },
    {
      label: '扩展页面',
      icon: <LuPuzzle className='w-5 h-5' />,
      href: '/extension',
    },
    {
      label: '系统终端',
      icon: <LuTerminal className='w-5 h-5' />,
      href: '/terminal',
    },
    {
      label: '系统配置',
      icon: <LuSettings className='w-5 h-5' />,
      href: '/config',
    },
    {
      label: '关于与版本',
      icon: <LuInfo className='w-5 h-5' />,
      href: '/about',
    },
  ] as MenuItem[],
  links: {
    github: 'https://github.com/ljy2231/Napcat-Plus',
    docs: 'https://github.com/ljy2231/Napcat-Plus#readme',
  },
};
