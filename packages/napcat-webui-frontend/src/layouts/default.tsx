import { Button } from '@heroui/button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { LuMenu, LuShieldCheck, LuExternalLink } from 'react-icons/lu';
import { Link, useLocation } from 'react-router-dom';
import errorFallbackRender from '@/components/error_fallback';
import SideBar from '@/components/sidebar';
import { siteConfig, type MenuItem } from '@/config/site';

function findTitle (menus: MenuItem[], pathname: string): string {
  for (const item of menus) {
    if (item.href === pathname) return item.label;
    if (item.items) {
      const title = findTitle(item.items, pathname);
      if (title) return title;
    }
  }
  return '';
}

/** Management remains accessible before QQ login, including diagnostics and GSCore. */
export default function Layout ({ children }: { children: React.ReactNode; }) {
  const location = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const closeSidebar = useCallback(() => setOpen(false), []);
  const title = useMemo(() => findTitle(siteConfig.navItems, location.pathname) || '控制台', [location.pathname]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    setOpen(false);
  }, [location.pathname]);
  return <div className='console-shell'>
    <a href='#console-main' className='console-skip-link'>跳到主要内容</a>
    <SideBar items={siteConfig.navItems} open={open} onClose={closeSidebar} />
    <div className='console-workspace' ref={contentRef}>
      <header className='console-topbar'>
        <div className='flex min-w-0 items-center gap-3'>
          <Button isIconOnly variant='light' size='sm' className='lg:hidden' aria-label='打开导航菜单' aria-expanded={open} onPress={() => setOpen(!open)}><LuMenu size={21} /></Button>
          <span className='console-breadcrumb-root'>控制台</span><span className='text-default-400'>/</span><strong className='truncate text-sm'>{title}</strong>
        </div>
        <div className='flex shrink-0 items-center gap-4'>
          <span className='console-session-label'><LuShieldCheck size={15} />管理会话</span>
          <Link to='/qq_login' className='console-topbar-link'>QQ 登录<LuExternalLink size={14} /></Link>
        </div>
      </header>
      <main id='console-main' className='console-main' tabIndex={-1}>
        <ErrorBoundary fallbackRender={errorFallbackRender} resetKeys={[location.pathname]}>{children}</ErrorBoundary>
      </main>
      <footer className='console-workspace-footer'><span>Napcat-Plus</span><span>基于 NapCat · 独立增强版</span></footer>
    </div>
  </div>;
}
