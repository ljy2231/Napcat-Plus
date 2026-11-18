import { Button } from '@heroui/button';
import { useRequest } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import ConsoleManager from '@/controllers/console_manager';
import { canStartDockerUpdate, dockerUpdateBusy, dockerUpdatePhaseLabel, isAcceptedDockerUpdate, parseDockerUpdateStatus } from '@/utils/docker-update';

/** Updates the host-approved Docker image, independently of release-tag checks. */
export function DockerUpdatePanel () {
  const request = useRequest(async () => {
    const status = parseDockerUpdateStatus(await ConsoleManager.getDockerUpdateStatus());
    if (!status) throw new Error('更新器状态格式无效');
    return status;
  }, { pollingInterval: 5000, pollingWhenHidden: false });
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const status = request.error ? undefined : request.data;
  const busy = !!status && dockerUpdateBusy(status.phase);
  const canStart = canStartDockerUpdate(status, submitting, uncertain) && !request.loading;

  // A confirmed fresh status read is required before another attempt after interruption.
  async function refreshStatus () {
    try {
      await request.runAsync();
      setUncertain(false);
      setNotice('已重新连接并刷新更新器状态。请核对状态后再操作。');
    } catch {
      setUncertain(true);
      setNotice('无法连接更新器，请稍后重新连接并刷新状态。');
    }
  }

  async function startUpdate () {
    if (lock.current || !canStart) return;
    lock.current = true;
    setSubmitting(true);
    setConfirming(false);
    setNotice('正在提交更新请求，容器可能重启并短暂断开连接。');
    try {
      const result = await ConsoleManager.startDockerUpdate();
      if (!isAcceptedDockerUpdate(result)) throw new Error('更新器未确认请求');
      setNotice('更新请求已受理；容器可能重启并断开连接，请稍后重新连接查看状态。受理不代表更新完成。');
      // The host may not yet have persisted its running phase. Require an explicit
      // status refresh before a further request instead of trusting an old idle state.
      setUncertain(true);
      request.refresh();
    } catch {
      setUncertain(true);
      setNotice('更新请求失败或连接中断，结果尚未确认。请重新连接并刷新状态，勿立即重复提交。');
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (request.error && !submitting) setConfirming(false);
  }, [request.error, submitting]);

  // Never unlock from the browser clock alone: refresh at expiry and wait for
  // the host to report a non-limited phase. Polling covers clock skew/failures.
  useEffect(() => {
    if (status?.phase !== 'rate_limited' || status.retryAt === undefined) return;
    const delay = status.retryAt * 1000 - Date.now();
    if (delay <= 0 || delay > 2147483647) return;
    const timer = window.setTimeout(() => request.refresh(), Math.ceil(delay));
    return () => window.clearTimeout(timer);
  }, [status?.phase, status?.retryAt, request.refresh]);

  return <section aria-labelledby='docker-update-title' className='rounded-xl bg-default-100/50 p-4 space-y-3'>
    <h2 id='docker-update-title' className='text-lg font-bold'>Docker 更新</h2>
    <p className='text-sm text-default-600'>更新器仅使用宿主机管理员预先批准的镜像与策略；版本检查结果不代表该镜像可用或已获批准。</p>
    <div role='status' aria-live='polite' className='text-sm space-y-1'>
      {request.loading && !status ? <p>正在读取更新器状态…</p> : !status ? <p>无法连接更新器，请重新连接并刷新状态。</p> : <>
        <p>{dockerUpdatePhaseLabel(status.phase)}</p>
        {status.generation !== undefined && <p>策略代数：{status.generation}</p>}
        {status.message && <p className='break-words text-default-500'>更新器信息：{status.message}</p>}
      </>}
      {notice && <p>{notice}</p>}
    </div>
    {status?.phase === 'succeeded' && <p className='text-xs text-warning'>镜像已应用，但持久化数据未备份。</p>}
    {status?.phase === 'failed' && <p className='text-xs text-warning'>请检查服务；持久化数据不会随镜像回滚。</p>}
    {status?.phase === 'blocked' && <p className='text-xs text-danger'>请联系宿主机管理员检查策略及日志，处理后再操作。</p>}
    {status?.phase === 'rate_limited' && <p className='text-xs text-warning'>请等待限制解除，页面会自动刷新状态；仍受限制时不可提交更新。</p>}
    {status && !status.enabled && <p className='text-xs text-default-500'>当前部署未启用宿主机更新器，请联系管理员。</p>}
    <div className='flex flex-wrap gap-2'>
      <Button size='sm' variant='bordered' isLoading={request.loading} onPress={() => { void refreshStatus(); }}>刷新更新器状态</Button>
      <Button size='sm' color='primary' isDisabled={!canStart || confirming} isLoading={submitting} onPress={() => setConfirming(true)}>更新 Docker</Button>
    </div>
    {busy && <p className='text-xs text-default-500'>更新进行中，请勿重复提交；容器重启时请稍后重新连接。</p>}
    {confirming && <div role='group' aria-labelledby='docker-update-confirm' className='rounded-lg border border-warning p-3 space-y-2'>
      <p id='docker-update-confirm' className='text-sm'>确认按宿主机批准的策略更新整个 Docker 容器？服务会短暂中断，更新不会备份或回滚持久化数据。请先备份。</p>
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' color='danger' isDisabled={!canStart} onPress={() => { void startUpdate(); }}>确认更新 Docker</Button>
        <Button size='sm' variant='bordered' onPress={() => setConfirming(false)}>取消</Button>
      </div>
    </div>}
  </section>;
}
