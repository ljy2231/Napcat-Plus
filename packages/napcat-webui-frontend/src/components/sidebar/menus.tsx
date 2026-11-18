import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LuChevronDown } from 'react-icons/lu';
import type { MenuItem } from '@/config/site';

function MenuEntry ({ item, onNavigate }: { item: MenuItem; onNavigate?: () => void; }) {
  const [open, setOpen] = useState(!!item.autoOpen);
  const { pathname } = useLocation();
  useEffect(() => {
    if (item.items?.some((child) => child.href === pathname)) setOpen(true);
  }, [item.items, pathname]);
  if (item.href) return <NavLink
    to={item.href}
    end={item.href === '/'}
    onClick={onNavigate}
    className={({ isActive }) => `console-nav-item ${isActive ? 'is-active' : ''}`}
  ><span className='console-nav-icon'>{item.icon}</span><span>{item.label}</span></NavLink>;
  return <div>
    <button className='console-nav-item w-full' onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className='console-nav-icon'>{item.icon}</span><span>{item.label}</span><LuChevronDown className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className='ml-4'>{item.items?.map((child) => <MenuEntry key={child.href || child.label} item={child} onNavigate={onNavigate} />)}</div>}
  </div>;
}

export default function Menus ({ items, onNavigate }: { items: MenuItem[]; onNavigate?: () => void; }) {
  return <nav aria-label='主导航' className='console-navigation'>
    {items.map((item, index) => <div key={item.href || item.label}>
      {(index === 0 || index === 3 || index === 11) && <div className='console-nav-section'>{index === 0 ? '工作空间' : index === 3 ? '连接与工具' : '系统管理'}</div>}
      <MenuEntry item={item} onNavigate={onNavigate} />
    </div>)}
  </nav>;
}
