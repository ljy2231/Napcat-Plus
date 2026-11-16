import { Link as RouterLink } from 'react-router-dom';
import { LuArrowUpRight, LuShieldCheck } from 'react-icons/lu';
import { ConsoleBrand } from '@/components/console-ui';
import { ThemeSwitch } from '@/components/theme-switch';
import { siteConfig } from '@/config/site';

export default function PureLayout ({ children }: { children: React.ReactNode; }) {
  return <div className='console-auth-shell'>
    <header className='console-auth-topbar'>
      <RouterLink to='/' aria-label='Napcat-Plus 首页'><ConsoleBrand compact /></RouterLink>
      <div className='flex items-center gap-5'><a className='console-auth-source' href={siteConfig.links.github} target='_blank' rel='noreferrer'>项目源码<LuArrowUpRight size={15} /></a><ThemeSwitch /></div>
    </header>
    <main className='console-auth-main'>{children}</main>
    <footer className='console-auth-footer'><span><LuShieldCheck size={14} />凭据仅发送至当前服务</span><span>Napcat-Plus · 基于 NapCat</span></footer>
  </div>;
}
