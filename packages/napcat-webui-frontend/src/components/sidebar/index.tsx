import { Button } from '@heroui/button';
import { useEffect, useRef } from 'react';
import { LuLogOut, LuMoon, LuSun, LuX, LuExternalLink } from 'react-icons/lu';
import { ConsoleBrand } from '@/components/console-ui';
import useAuth from '@/hooks/auth';
import useDialog from '@/hooks/use-dialog';
import { useTheme } from '@/hooks/use-theme';
import { siteConfig, type MenuItem } from '@/config/site';
import Menus from './menus';

export default function SideBar ({ open, items, onClose }: { open: boolean; items: MenuItem[]; onClose?: () => void; }) {
  const { toggleTheme, isDark } = useTheme();
  const { revokeAuth } = useAuth();
  const dialog = useDialog();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || window.matchMedia('(min-width: 1024px)').matches) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])') || []).filter((element) => element.offsetParent !== null);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus(); };
  }, [open, onClose]);
  return <>
    {open && <button className='console-sidebar-backdrop' aria-label='关闭导航菜单' onClick={onClose} />}
    <aside ref={panelRef} className={`console-sidebar ${open ? 'is-open' : ''}`} aria-label='控制台导航'>
      <div className='console-sidebar-brand'><ConsoleBrand /><Button ref={closeRef} isIconOnly size='sm' variant='light' className='lg:hidden' aria-label='关闭导航' onPress={onClose}><LuX size={20} /></Button></div>
      <div className='console-sidebar-scroll'><Menus items={items} onNavigate={onClose} /></div>
      <footer className='console-sidebar-footer'>
        <a href={siteConfig.links.github} target='_blank' rel='noreferrer' className='console-repo-link'>项目与更新<LuExternalLink size={14} /></a>
        <div className='flex items-center gap-2'>
          <Button className='flex-1' size='sm' variant='flat' startContent={isDark ? <LuSun /> : <LuMoon />} onPress={toggleTheme}>{isDark ? '浅色主题' : '深色主题'}</Button>
          <Button isIconOnly size='sm' variant='light' aria-label='退出管理登录' onPress={() => dialog.confirm({ title: '退出管理登录', content: '仅退出当前浏览器的管理会话，不会让 QQ 下线。', onConfirm: revokeAuth })}><LuLogOut size={18} /></Button>
        </div>
      </footer>
    </aside>
  </>;
}
