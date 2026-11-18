import { Button } from '@heroui/button';
import { useRequest } from 'ahooks';
import { useEffect, useRef, useState } from 'react';
import ConsoleManager from '@/controllers/console_manager';
import { canStartDockerUpdate, dockerUpdateBusy, dockerUpdateError, dockerUpdatePhaseLabel, isAcceptedDockerUpdate, parseDockerUpdatePreview, parseDockerUpdateStatus } from '@/utils/docker-update';
import type { DockerUpdatePreview, DockerUpdateSource } from '@/utils/docker-update';

/** Updates the Docker image, independently of the displayed release-tag check. */
export function DockerUpdatePanel () {
  const request = useRequest(async () => {
    const status = parseDockerUpdateStatus(await ConsoleManager.getDockerUpdateStatus());
    if (!status) throw new Error('更新器状态格式无效');
    return status;
  }, { pollingInterval: 5000, pollingWhenHidden: false });
  const [source, setSource] = useState<DockerUpdateSource>('ghcr');
  const [confirming, setConfirming] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<(DockerUpdatePreview & { source: DockerUpdateSource }) | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const previewSequence = useRef(0);
  const currentSource = useRef(source);
  currentSource.current = source;
  const status = request.error ? undefined : request.data;
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const busy = !!status && dockerUpdateBusy(status.phase);
  const canStart = canStartDockerUpdate(status, submitting || previewing, uncertain) && !request.loading;

  async function prepareUpdate () {
    if (lock.current || !canStart) return;
    lock.current = true;
    const sequence = ++previewSequence.current;
    const selectedSource = source;
    setPreview(null);
    setPreviewing(true);
    setNotice('正在获取最新正式版本和镜像摘要…');
    try {
      const checked = parseDockerUpdatePreview(await ConsoleManager.previewDockerUpdate());
      if (previewSequence.current !== sequence) return;
      if (!checked) throw new Error('预检结果缺少有效的正式版本或完整 SHA-256 摘要');
      if (currentSource.current !== selectedSource || !canStartDockerUpdate(currentStatus.current, false, uncertain)) {
        throw new Error('更新状态或下载源已变化，请重新预检');
      }
      setPreview({ ...checked, source: selectedSource });
      setConfirming(true);
      setNotice('请核对预检版本、完整摘要和下载源。');
    } catch (error) {
      if (previewSequence.current !== sequence) return;
      setPreview(null);
      setConfirming(false);
      setNotice(`更新预检失败：${dockerUpdateError(error)}。未发送更新请求，请重试。`);
    } finally {
      if (previewSequence.current === sequence) {
        lock.current = false;
        setPreviewing(false);
      }
    }
  }

  function cancelPreview () {
    previewSequence.current += 1;
    setConfirming(false);
    setPreview(null);
  }

  // A confirmed fresh status read is required before another attempt after interruption.
  async function refreshStatus () {
    try {
      await request.runAsync();
      setUncertain(false);
      setNotice('已重新连接并刷新更新器状态。请核对状态后再操作。');
    } catch (error) {
      setUncertain(true);
      setNotice(`无法连接更新器：${dockerUpdateError(error)}。请稍后重新连接并刷新状态。`);
    }
  }

  async function startUpdate () {
    if (lock.current || !canStart || !confirming || !preview || preview.source !== source) return;
    lock.current = true;
    setSubmitting(true);
    setConfirming(false);
    setPreview(null);
    setNotice('正在提交更新请求，容器可能重启并短暂断开连接。');
    try {
      const result = await ConsoleManager.startDockerUpdate(preview.source, preview.version, preview.digest);
      if (!isAcceptedDockerUpdate(result)) throw new Error('更新器未确认请求');
      setNotice('更新请求已受理；容器可能重启并断开连接，请稍后重新连接查看状态。受理不代表更新完成。');
      // The host may not yet have persisted its running phase. Require an explicit
      // status refresh before a further request instead of trusting an old idle state.
      setUncertain(true);
      request.refresh();
    } catch (error) {
      setUncertain(true);
      setNotice(`更新请求失败或连接中断：${dockerUpdateError(error)}。结果尚未确认，请重新连接并刷新状态，勿立即重复提交。`);
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    // Status becoming unavailable/busy invalidates any previously checked artifact.
    if (!status || !status.enabled || dockerUpdateBusy(status.phase) || status.phase === 'blocked' || status.phase === 'rate_limited') {
      setConfirming(false);
      setPreview(null);
    }
  }, [status?.enabled, status?.phase]);

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
    <p className='text-sm text-default-600'>下载源仅用于获取新版本，不切换已安装版本的来源。更新自动信任本项目正式 Release 和 GHCR 的官方版本及官方 SHA，不逐版人工批准；国内镜像站仅加速镜像层下载，镜像以官方摘要校验；获取版本和摘要仍需直连 GitHub/GHCR 元数据，镜像站不作为版本或摘要的信任来源。</p>
    <fieldset disabled={!canStart || confirming} className='text-sm space-y-1'>
      <legend className='font-semibold'>下载源</legend>
      <label className='flex items-center gap-2'><input type='radio' name='docker-update-source' value='ghcr' checked={source === 'ghcr'} onChange={() => setSource('ghcr')} />GHCR 直连（默认）</label>
      <label className='flex items-center gap-2'><input type='radio' name='docker-update-source' value='mirror' checked={source === 'mirror'} onChange={() => setSource('mirror')} />mirror 国内镜像站</label>
    </fieldset>
    <div role='status' aria-live='polite' className='text-sm space-y-1'>
      {request.loading && !status ? <p>正在读取更新器状态…</p> : !status ? <p>无法连接更新器{request.error ? `：${dockerUpdateError(request.error)}` : ''}，请重新连接并刷新状态。</p> : <>
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
      <Button size='sm' color='primary' isDisabled={!canStart || confirming} isLoading={submitting || previewing} onPress={() => { void prepareUpdate(); }}>更新 Docker</Button>
    </div>
    {busy && <p className='text-xs text-default-500'>更新进行中，请勿重复提交；容器重启时请稍后重新连接。</p>}
    {confirming && preview && <div role='group' aria-labelledby='docker-update-confirm' className='rounded-lg border border-warning p-3 space-y-2'>
      <p id='docker-update-confirm' className='text-sm'>确认使用 {preview.source === 'ghcr' ? 'GHCR 直连' : 'mirror 国内镜像站'} 下载并更新整个 Docker 容器？本次更新自动信任本项目正式 Release 和 GHCR 的官方版本及官方 SHA，不逐版人工批准；镜像以官方摘要校验。服务会短暂中断，更新不会备份或回滚持久化数据。请先备份。</p>
      <dl className='text-sm space-y-1'>
        <div><dt className='inline font-semibold'>版本：</dt><dd className='inline'>{preview.version}</dd></div>
        <div><dt className='inline font-semibold'>完整镜像摘要：</dt><dd className='inline break-all font-mono'>{preview.digest}</dd></div>
        <div><dt className='inline font-semibold'>下载源：</dt><dd className='inline'>{preview.source === 'ghcr' ? 'GHCR 直连' : 'mirror 国内镜像站'}</dd></div>
      </dl>
      <div className='flex flex-wrap gap-2'>
        <Button size='sm' color='danger' isDisabled={!canStart || preview.source !== source} onPress={() => { void startUpdate(); }}>确认更新 Docker</Button>
        <Button size='sm' variant='bordered' onPress={cancelPreview}>取消</Button>
      </div>
    </div>}
  </section>;
}
