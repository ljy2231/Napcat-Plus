import { Button } from '@heroui/button';
import { Spinner } from '@heroui/spinner';
import { QRCodeSVG } from 'qrcode.react';
import { LuCircleAlert, LuRefreshCw, LuScanLine } from 'react-icons/lu';

interface QrCodeLoginProps {
  qrcode: string;
  loginError?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  loginPhase?: string;
  isRecoveringLoginService?: boolean;
}

export default function QrCodeLogin ({ qrcode, loginError, onRefresh, isRefreshing = false, loginPhase, isRecoveringLoginService = false }: QrCodeLoginProps) {
  const transitionMessage = loginPhase === 'qrcode_scanned' ? '已扫描，请在手机 QQ 上确认' : loginPhase === 'initializing' ? '已确认登录，正在启动核心服务' : loginPhase === 'reconnecting' || isRecoveringLoginService ? '正在恢复 QQ 登录服务' : isRefreshing ? '正在请求新的二维码' : '';
  const cannotRefresh = isRefreshing || isRecoveringLoginService || ['qrcode_scanned', 'initializing', 'reconnecting'].includes(loginPhase || '');
  return <div className='flex flex-col items-center gap-5'>
    {transitionMessage && <div role='status' className='console-qr-notice w-full'><Spinner size='sm' /><span>{transitionMessage}。请保留此页面，状态将自动更新。</span></div>}
    {loginError && <div className='flex gap-2 rounded-lg bg-danger-50 p-3 text-danger text-xs leading-relaxed w-full' role='alert'><LuCircleAlert size={17} className='shrink-0 mt-0.5' /><span>{loginError}</span></div>}
    <div className='console-qr-frame'>
      {qrcode && !isRefreshing ? <QRCodeSVG key={qrcode} size={180} value={qrcode} title='QQ 登录二维码，请使用手机 QQ 扫描' /> : <div className='flex flex-col items-center gap-3 px-4 py-8 text-center text-slate-500'>
        {loginError ? <LuCircleAlert size={30} /> : <Spinner color='primary' />}
        <span className='text-xs max-w-40 leading-relaxed'>{loginError ? '暂时无法取得二维码' : '等待 QQ 服务生成二维码'}</span>
      </div>}
    </div>
    <div className='flex items-center gap-2 text-xs text-default-500'><LuScanLine size={16} />使用手机 QQ 扫码并确认登录</div>
    {onRefresh && <Button variant='flat' color='primary' size='sm' startContent={!isRefreshing && <LuRefreshCw />} onPress={onRefresh} isLoading={isRefreshing} isDisabled={cannotRefresh}>{qrcode ? '刷新二维码' : '重新获取二维码'}</Button>}
    <p className='text-[11px] text-default-400 text-center leading-relaxed'>二维码仅用于本次登录，请勿转发。未收到二维码时不会显示占位二维码。</p>
  </div>;
}
