import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { Switch } from '@heroui/switch';
import { Checkbox } from '@heroui/checkbox';
import { useEffect, useState } from 'react';
import { useRequest } from 'ahooks';
import toast from 'react-hot-toast';
import { LuCable, LuKeyRound, LuRefreshCw, LuSave, LuShieldCheck } from 'react-icons/lu';
import { ApiError, ConsoleLoading, ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';
import ConsoleManager from '@/controllers/console_manager';
import useConsoleStatus from '@/hooks/use-console-status';
import useDialog from '@/hooks/use-dialog';
import { buildGSCoreUpdate, gscorePresentation, validateGSCoreConfig } from '@/utils/console';
import type { GSCoreConfig } from '@/types/console';

export default function GSCorePage () {
  const dialog = useDialog();
  const status = useConsoleStatus();
  const config = useRequest(ConsoleManager.getGSCoreConfig);
  const [draft, setDraft] = useState<GSCoreConfig>();
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [formError, setFormError] = useState('');
  useEffect(() => { if (config.data) setDraft(config.data); }, [config.data]);
  const current = status.error ? undefined : status.data?.gscore;
  const badge = gscorePresentation(current?.state);
  const dirty = !!draft && !!config.data && (draft.enabled !== config.data.enabled || draft.url !== config.data.url || draft.reconnectIntervalMs !== config.data.reconnectIntervalMs || draft.maxReconnectAttempts !== config.data.maxReconnectAttempts || !!token || clearToken);
  const update = (values: Partial<GSCoreConfig>) => setDraft((value) => value && { ...value, ...values });

  const save = async () => {
    if (!draft || saving) return;
    const error = validateGSCoreConfig(draft);
    if (error) { setFormError(error); return; }
    setSaving(true); setFormError('');
    try {
      const saved = await ConsoleManager.setGSCoreConfig(buildGSCoreUpdate(draft, token, clearToken));
      config.mutate(saved); setDraft(saved); setToken(''); setClearToken(false);
      toast.success('GSCore 配置已保存'); status.refresh();
    } catch (error) { setFormError((error as Error).message); }
    finally { setSaving(false); }
  };

  const confirmSave = () => {
    if (!draft) return;
    const error = validateGSCoreConfig(draft);
    if (error) { setFormError(error); return; }
    const destructive = (config.data?.enabled && !draft.enabled) || clearToken || current?.connected;
    if (destructive) dialog.confirm({ title: clearToken ? '确认清除 Token 并保存？' : '确认更新 GSCore 连接？', content: clearToken ? '将删除服务端已保存的 GSCore Token；若服务要求鉴权，清除后将无法连接。其他修改会一同保存。' : '此操作会应用新的连接设置，可能短暂中断消息桥接。QQ 登录不会受影响。', confirmText: '确认保存', onConfirm: save });
    else void save();
  };

  const reconnect = () => dialog.confirm({
    title: '重新连接 GSCore',
    content: '将断开当前 GSCore 连接并使用已保存的配置重新连接。未保存的表单修改不会应用。',
    confirmText: '重新连接',
    onConfirm: async () => {
      setReconnecting(true);
      try { await ConsoleManager.reconnectGSCore(); toast.success('已发送重新连接请求'); status.refresh(); }
      catch (error) { toast.error((error as Error).message); }
      finally { setReconnecting(false); }
    },
  });

  return <>
    <title>GSCore 连接 · QQ Bot Console</title>
    <ConsolePageHeader eyebrow='INTEGRATIONS / GSCORE' title='GSCore 连接管理' description='管理消息桥接、鉴权与重试策略。配置保存在服务端，不回显已存 Token。' actions={<Button size='sm' variant='bordered' onPress={status.refresh} isLoading={status.loading} startContent={<LuRefreshCw />}>刷新状态</Button>} />
    {status.error && <ApiError error={status.error} onRetry={status.refresh} />}
    {config.error && <ApiError error={config.error} onRetry={config.refresh} />}
    <div className='console-content-grid'>
      <ConsolePanel title='连接设置' description='保存后应用配置；Token 留空默认保持不变。'>
        {config.loading && !draft ? <ConsoleLoading label='正在加载 GSCore 配置…' /> : !draft ? <div className='console-empty'>配置尚未加载，暂时不能修改。请重试上方请求。</div> : <form className='console-form-section' onSubmit={(event) => { event.preventDefault(); confirmSave(); }}>
          <div className='flex items-center justify-between gap-4 rounded-xl bg-default-50 p-4'><div><strong className='text-sm'>启用 GSCore 桥接</strong><p className='text-xs text-default-500 mt-1 leading-relaxed'>关闭后停止连接与消息转发，不会退出 QQ。</p></div><Switch aria-label='启用 GSCore 桥接' isSelected={draft.enabled} onValueChange={(enabled) => update({ enabled })} isDisabled={saving || !!config.error} /></div>
          <Input label='WebSocket 连接地址' labelPlacement='outside' placeholder='ws://gsuid_core:8765' value={draft.url} onValueChange={(url) => update({ url })} isDisabled={saving || !!config.error} variant='bordered' startContent={<LuCable className='text-default-400' />} description='支持 ws:// 与 wss://。跨公网建议使用 wss://；不要将 Token 放进 URL。' />
          <Input label='连接 Token' labelPlacement='outside' type='password' autoComplete='new-password' value={token} onValueChange={setToken} isDisabled={saving || clearToken || !!config.error} variant='bordered' placeholder={draft.tokenConfigured ? '已配置 · 留空保留现有 Token' : '未配置 · 按需填写'} startContent={<LuKeyRound className='text-default-400' />} description='仅在输入新值时替换。现有 Token 不会返回浏览器，也不会放入本地存储。' />
          {draft.tokenConfigured && <Checkbox size='sm' color='danger' isSelected={clearToken} onValueChange={(value) => { setClearToken(value); if (value) setToken(''); }} isDisabled={saving || !!config.error}>清除服务端已保存的 Token（保存时确认）</Checkbox>}
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-5'>
            <Input type='number' label='重连间隔（毫秒）' labelPlacement='outside' min={1000} max={300000} step={1000} value={String(draft.reconnectIntervalMs)} onValueChange={(value) => update({ reconnectIntervalMs: Number(value) })} variant='bordered' isDisabled={saving || !!config.error} description='1,000–300,000 毫秒' />
            <Input type='number' label='最大重试次数' labelPlacement='outside' min={1} max={100} step={1} value={String(draft.maxReconnectAttempts)} onValueChange={(value) => update({ maxReconnectAttempts: Number(value) })} variant='bordered' isDisabled={saving || !!config.error} description='1–100 次，不进行无限重试' />
          </div>
          {!draft.enabled && <div className='console-form-note'>当前表单设置为「未启用」。你仍可以保存连接地址与鉴权配置，准备好后再启用。</div>}
          {formError && <p role='alert' className='text-sm text-danger leading-relaxed'>{formError}</p>}
          <div className='console-form-actions'><Button variant='flat' isDisabled={!dirty || saving} onPress={() => { setDraft(config.data); setToken(''); setClearToken(false); setFormError(''); }}>放弃修改</Button><Button color='primary' type='submit' startContent={!saving && <LuSave />} isLoading={saving} isDisabled={!dirty || !!config.error}>保存配置</Button></div>
        </form>}
      </ConsolePanel>
      <div className='flex flex-col gap-5'>
        <ConsolePanel title='当前连接' description='来自服务端的实时状态。' actions={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}>
          {status.loading && !status.data ? <ConsoleLoading /> : <>
            <dl className='console-fact-list'>
              <div className='console-fact'><dt>服务启用</dt><dd>{current ? (current.enabled ? '已启用' : '已关闭') : '—'}</dd></div>
              <div className='console-fact'><dt>WebSocket</dt><dd>{current?.url || '—'}</dd></div>
              <div className='console-fact'><dt>本轮重试</dt><dd>{current ? `${current.reconnectAttempts} 次` : '—'}</dd></div>
              <div className='console-fact'><dt>连接凭据</dt><dd>{current ? (current.tokenConfigured ? '已配置（不回显）' : '未配置') : '—'}</dd></div>
            </dl>
            {current?.lastError && <p role='alert' className='mt-5 text-xs text-danger leading-relaxed break-words'>{current.lastError}</p>}
            <Button className='w-full mt-6' variant='flat' color='primary' startContent={!reconnecting && <LuRefreshCw />} isLoading={reconnecting} isDisabled={!current?.enabled || !!status.error || saving} onPress={reconnect}>重新连接</Button>
            {!current?.enabled && <p className='text-xs text-default-500 mt-3 leading-relaxed'>先保存并启用 GSCore，才能手动重新连接。</p>}
          </>}
        </ConsolePanel>
        <ConsolePanel title='部署提示' description='容器内 localhost 指向当前容器本身。'>
          <div className='console-form-note'>同一 Docker 网络内优先使用服务名，例如 <code>ws://gsuid_core:8765</code>。若 GSCore 共享其他容器的网络命名空间，请填写那个容器的服务名。请勿直接照搬其他机器的网桥 IP。</div>
          <div className='flex items-start gap-2 mt-4 text-xs text-default-500 leading-relaxed'><LuShieldCheck className='shrink-0 mt-0.5' size={16} />该页面不会修改 QQ 账号、设备标识或聊天数据。</div>
        </ConsolePanel>
      </div>
    </div>
  </>;
}
