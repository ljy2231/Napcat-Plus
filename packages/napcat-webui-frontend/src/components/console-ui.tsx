import type { ReactNode } from 'react';
import { LuBot, LuCircleAlert, LuRefreshCw } from 'react-icons/lu';
import { Button } from '@heroui/button';
import { Spinner } from '@heroui/spinner';
import type { StatusTone } from '@/utils/console';

export function ConsoleBrand ({ compact = false }: { compact?: boolean; }) {
  return <div className='console-brand'>
    <span className='console-brand-mark' aria-hidden='true'><LuBot size={23} /></span>
    <div><strong>QQ Bot Console</strong>{!compact && <span>连接 · 管理 · 观察</span>}</div>
  </div>;
}

export function StatusBadge ({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode; }) {
  return <span className={`console-status console-status-${tone}`}><span aria-hidden='true' />{children}</span>;
}

export function ConsolePageHeader ({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode; }) {
  return <header className='console-page-heading'>
    <div><span className='console-eyebrow'>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
    {actions && <div className='console-heading-actions'>{actions}</div>}
  </header>;
}

export function ConsolePanel ({ title, description, actions, children, className = '' }: { title: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string; }) {
  return <section className={`console-panel ${className}`}>
    <header className='console-panel-heading'><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions}</header>
    {children}
  </section>;
}

export function ApiError ({ error, onRetry }: { error?: Error; onRetry: () => void; }) {
  return <div className='console-error' role='alert'>
    <LuCircleAlert size={20} className='shrink-0' />
    <div><strong>无法读取服务状态</strong><p>{error?.message || '请求失败，请检查服务连接后重试。'} 数据不可用时不会显示为在线。</p></div>
    <Button size='sm' variant='flat' onPress={onRetry} startContent={<LuRefreshCw />}>重试</Button>
  </div>;
}

export function ConsoleLoading ({ label = '正在读取服务数据…' }: { label?: string; }) {
  return <div className='console-loading' role='status'><Spinner size='sm' /><span>{label}</span></div>;
}
