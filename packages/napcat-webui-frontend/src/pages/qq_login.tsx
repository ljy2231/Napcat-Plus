import { Button } from '@heroui/button';
import { Tab, Tabs } from '@heroui/tabs';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import CryptoJS from 'crypto-js';
import { LuArrowLeft, LuSettings, LuShieldCheck } from 'react-icons/lu';
import { ConsolePageHeader, ConsolePanel, StatusBadge } from '@/components/console-ui';
import { loginPresentation } from '@/utils/console';
import GUIDManager from '@/components/guid_manager';
import Modal from '@/components/modal';

import PasswordLogin from '@/components/password_login';
import QrCodeLogin from '@/components/qr_code_login';
import QuickLogin from '@/components/quick_login';
import type { CaptchaCallbackData } from '@/components/tencent_captcha';

import QQManager from '@/controllers/qq_manager';
import useDialog from '@/hooks/use-dialog';
import PureLayout from '@/layouts/pure';

const parseLoginError = (errorStr: string) => {
  if (errorStr.startsWith('登录失败: ')) {
    const jsonPart = errorStr.substring('登录失败: '.length);

    try {
      const parsed = JSON.parse(jsonPart);

      if (Array.isArray(parsed) && parsed[1]) {
        const info = parsed[1];
        const codeStr = info.serverErrorCode ? ` (错误码: ${info.serverErrorCode})` : '';

        return `${info.message || errorStr}${codeStr}`;
      }
    } catch (_e) {
      // 忽略解析错误
    }
  }

  return errorStr;
};

export default function QQLoginPage () {
  const navigate = useNavigate();
  const dialog = useDialog();
  const [uinValue, setUinValue] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [qrcode, setQrcode] = useState<string>('');
  const [loginPhase, setLoginPhase] = useState<string>('waiting_qrcode');
  const [isRecoveringLoginService, setIsRecoveringLoginService] = useState(false);
  const qrcodeRef = useRef<string>('');
  const qrcodeRequestVersionRef = useRef(0);
  const isRefreshingQRCodeRef = useRef(false);
  const [loginError, setLoginError] = useState<string>('');
  const lastErrorRef = useRef<string>('');
  const [qqList, setQQList] = useState<LoginListItem[]>([]);
  const [refresh, setRefresh] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>('qrcode');
  const [statusError, setStatusError] = useState('');
  const pollBusyRef = useRef(false);
  const firstLoad = useRef<boolean>(true);
  const [captchaState, setCaptchaState] = useState<{
    needCaptcha: boolean;
    proofWaterUrl: string;
    uin: string;
    password: string;
  } | null>(null);
  const [captchaVerifying, setCaptchaVerifying] = useState(false);
  const [newDeviceState, setNewDeviceState] = useState<{
    needNewDevice: boolean;
    jumpUrl: string;
    newDevicePullQrCodeSig: string;
    uin: string;
    password: string;
  } | null>(null);
  // newDevicePullQrCodeSig is kept for step:2 login after QR verification
  const onSubmit = async () => {
    if (!uinValue) {
      toast.error('请选择快捷登录的QQ');

      return;
    }
    setIsLoading(true);
    try {
      await QQManager.setQuickLogin(uinValue);
    } catch (error) {
      const msg = (error as Error).message;

      toast.error(`快速登录QQ失败: ${msg}`);
    } finally {
      setTimeout(() => {
        setIsLoading(false);
      }, 1000);
    }
  };

  const onPasswordSubmit = async (uin: string, password: string) => {
    setIsLoading(true);
    try {
      // 计算密码的MD5值
      const passwordMd5 = CryptoJS.MD5(password).toString();
      const result = await QQManager.passwordLogin(uin, passwordMd5);
      if (result?.needCaptcha && result.proofWaterUrl) {
        // 需要验证码，显示验证码组件
        setCaptchaState({
          needCaptcha: true,
          proofWaterUrl: result.proofWaterUrl,
          uin,
          password,
        });
        toast('需要安全验证，请完成验证码', { icon: '🔒' });
      } else if (result?.needNewDevice && result.jumpUrl) {
        setNewDeviceState({
          needNewDevice: true,
          jumpUrl: result.jumpUrl,
          newDevicePullQrCodeSig: result.newDevicePullQrCodeSig || '',
          uin,
          password,
        });
        toast('检测到新设备，请扫码验证', { icon: '📱' });
      } else {
        toast.success('密码登录请求已发送');
      }
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`密码登录失败: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  const onCaptchaSubmit = async (uin: string, password: string, captchaData: CaptchaCallbackData) => {
    setIsLoading(true);
    setCaptchaVerifying(true);
    try {
      const passwordMd5 = CryptoJS.MD5(password).toString();
      const result = await QQManager.captchaLogin(uin, passwordMd5, captchaData.ticket, captchaData.randstr, captchaData.sid);
      if (result?.needNewDevice && result.jumpUrl) {
        setCaptchaState(null);
        setNewDeviceState({
          needNewDevice: true,
          jumpUrl: result.jumpUrl,
          newDevicePullQrCodeSig: result.newDevicePullQrCodeSig || '',
          uin,
          password,
        });
        toast('检测到异常设备，请扫码验证', { icon: '📱' });
      } else {
        toast.success('验证码登录请求已发送');
        setCaptchaState(null);
      }
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`验证码登录失败: ${msg}`);
      setCaptchaState(null);
    } finally {
      setIsLoading(false);
      setCaptchaVerifying(false);
    }
  };

  const onCaptchaCancel = () => {
    setCaptchaState(null);
  };

  const onNewDeviceVerified = async (token: string) => {
    if (!newDeviceState) return;
    setIsLoading(true);
    try {
      const passwordMd5 = CryptoJS.MD5(newDeviceState.password).toString();
      // Use the str_nt_succ_token from QR verification as newDevicePullQrCodeSig for step:2
      const sig = token || newDeviceState.newDevicePullQrCodeSig;
      const result = await QQManager.newDeviceLogin(newDeviceState.uin, passwordMd5, sig);
      if (result?.needNewDevice && result.jumpUrl) {
        // 新设备验证后又触发了异常设备验证，更新 jumpUrl
        setNewDeviceState({
          needNewDevice: true,
          jumpUrl: result.jumpUrl,
          newDevicePullQrCodeSig: result.newDevicePullQrCodeSig || '',
          uin: newDeviceState.uin,
          password: newDeviceState.password,
        });
        toast('检测到异常设备，请继续扫码验证', { icon: '📱' });
      } else {
        toast.success('新设备验证登录请求已发送');
        setNewDeviceState(null);
      }
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`新设备验证登录失败: ${msg}`);
      setNewDeviceState(null);
    } finally {
      setIsLoading(false);
    }
  };

  const onNewDeviceCancel = () => {
    setNewDeviceState(null);
  };

  const onUpdateQrCode = async () => {
    if (pollBusyRef.current) return;
    pollBusyRef.current = true;
    const requestVersion = qrcodeRequestVersionRef.current;
    if (firstLoad.current) setIsLoading(true);
    try {
      const data = await QQManager.checkQQLoginStatusWithQrcode();
      setStatusError('');
      setLoginPhase(data.loginPhase || (data.isLogin ? 'ready' : 'waiting_qrcode'));
      if (data.loginPhase === 'reconnecting') {
        setIsRecoveringLoginService(true);
      }

      if (data.isLogin) {
        toast.success('QQ登录成功');
        navigate('/', { replace: true });
      } else {
        // 刷新二维码是一个需要等待结果的操作。忽略在它开始前发出的
        // 轮询响应，避免旧 URL 在刷新完成后覆盖刚拿到的新二维码。
        if (requestVersion === qrcodeRequestVersionRef.current && !isRefreshingQRCodeRef.current) {
          qrcodeRef.current = data.qrcodeurl;
          setQrcode(data.qrcodeurl);
          if (data.qrcodeurl) {
            setIsRecoveringLoginService(false);
          }
        }
        if (data.loginError && data.loginError !== lastErrorRef.current) {
          lastErrorRef.current = data.loginError;
          setLoginError(data.loginError);
          // Polling errors remain inline; do not repeatedly interrupt users with dialogs.
        } else if (!data.loginError) {
          lastErrorRef.current = '';
          setLoginError('');
        }
      }
    } catch (error) {
      const msg = (error as Error).message;
      // Worker 重启时，旧连接被关闭是预期现象。恢复状态持续轮询即可，
      // 不要把 ERR_EMPTY_RESPONSE 作为用户可操作的错误反复弹出。
      setStatusError(isRecoveringLoginService ? '登录服务正在恢复，等待接口重新连接。' : `获取登录状态失败：${msg}`);
    } finally {
      pollBusyRef.current = false;
      if (firstLoad.current) {
        setIsLoading(false);
        firstLoad.current = false;
      }
    }
  };

  const onUpdateQQList = async () => {
    setRefresh(true);
    try {
      const data = await QQManager.getQQQuickLoginListNew();
      setQQList(data);
    } catch (error) {
      const msg = (error as Error).message;
      toast.error(`获取QQ列表失败: ${msg}`);
    } finally {
      setRefresh(false);
    }
  };

  const handleSelectionChange: React.ChangeEventHandler<HTMLSelectElement> = (
    e
  ) => {
    setUinValue(e.target.value);
  };

  const onRefreshQRCode = async () => {
    if (isRecoveringLoginService || loginPhase === 'reconnecting') {
      toast('QQ 登录服务正在恢复，请等待新的二维码…', { icon: '⏳' });
      return;
    }
    if (isRefreshingQRCodeRef.current) {
      return;
    }
    qrcodeRequestVersionRef.current += 1;
    isRefreshingQRCodeRef.current = true;
    setIsRefreshingQRCode(true);
    try {
      lastErrorRef.current = '';
      setLoginError('');
      const { qrcodeurl, restarting } = await QQManager.refreshQRCode();
      if (restarting) {
        setIsRecoveringLoginService(true);
        setLoginPhase('reconnecting');
        return;
      }
      if (!qrcodeurl || qrcodeurl === qrcodeRef.current) {
        throw new Error('未获取到新的二维码');
      }
      qrcodeRef.current = qrcodeurl;
      setQrcode(qrcodeurl);
      toast.success('二维码已刷新');
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('QQ_LOGIN_SERVICE_RESTARTING')) {
        setIsRecoveringLoginService(true);
        setLoginPhase('reconnecting');
        toast('QQ 登录服务正在重启，正在生成新的二维码…', { icon: '⏳' });
      } else if (msg.includes('二维码刷新超时')) {
        toast.error('未能取得新的二维码，请稍后重试');
      } else {
        toast.error(`刷新二维码失败: ${msg}`);
      }
    } finally {
      qrcodeRequestVersionRef.current += 1;
      isRefreshingQRCodeRef.current = false;
      setIsRefreshingQRCode(false);
    }
  };

  const [showGUIDManager, setShowGUIDManager] = useState(false);
  const [isRefreshingQRCode, setIsRefreshingQRCode] = useState(false);

  useEffect(() => {
    const isLoginTransitioning = loginPhase === 'qrcode_scanned' || loginPhase === 'initializing' || loginPhase === 'reconnecting' || isRecoveringLoginService;
    const pollInterval = isRefreshingQRCode || isLoginTransitioning ? 500 : 3000;
    const timer = setInterval(() => {
      onUpdateQrCode();
    }, pollInterval);

    onUpdateQrCode();

    return () => clearInterval(timer);
  }, [isRefreshingQRCode, loginPhase, isRecoveringLoginService]);

  useEffect(() => {
    onUpdateQQList();
  }, []);

  useEffect(() => {
    if (!isRecoveringLoginService) return;
    const timer = setTimeout(() => {
      setIsRecoveringLoginService(false);
      setLoginPhase('offline');
      setLoginError('QQ 登录服务恢复超时，请稍后重试');
    }, 180_000);
    return () => clearTimeout(timer);
  }, [isRecoveringLoginService]);

  const presentation = loginPresentation({ isLogin: false, isOffline: loginPhase === 'offline', loginPhase, coreReady: false, loginError: parseLoginError(loginError) });
  const phaseIndex = loginPhase === 'initializing' ? 2 : loginPhase === 'qrcode_scanned' ? 1 : 0;

  return (
    <>
      <title>QQ 登录状态 · QQ Bot Console</title>
      <PureLayout>
        <div className='console-login-workspace'>
          <ConsolePageHeader eyebrow='ACCOUNT CONNECTION' title='连接你的 QQ 账号' description='管理登录已完成。继续登录 QQ，或先返回控制台配置其他服务。' actions={<Button variant='bordered' size='sm' startContent={<LuArrowLeft />} onPress={() => navigate('/')}>返回控制台</Button>} />
          <div className='console-login-grid'>
            <ConsolePanel title='账号登录' description='推荐使用手机 QQ 扫码，登录过程由 QQ 服务处理。' actions={<Button isIconOnly size='sm' variant='light' aria-label='设备设置' onPress={() => dialog.confirm({ title: '打开设备高级设置', content: '设备 GUID 会影响 QQ 登录环境。仅在明确需要时修改；请勿为解决普通网络故障随意重置。', confirmText: '查看设置', onConfirm: () => setShowGUIDManager(true) })}><LuSettings size={19} /></Button>}>
              <div className='console-login-state' aria-live='polite'>
                <div className='flex justify-between items-center gap-3 mb-3'><h2 className='!mb-0'>{statusError ? '状态暂不可用' : presentation.label}</h2><StatusBadge tone={statusError ? 'danger' : presentation.tone}>{statusError ? '连接中断' : '实时登录状态'}</StatusBadge></div>
                <p>{statusError || presentation.detail}</p>
              </div>
              <Tabs fullWidth aria-label='QQ 登录方式' isDisabled={isLoading} size='md' selectedKey={activeTab} onSelectionChange={(key) => key !== null && setActiveTab(key.toString())} classNames={{ panel: 'pt-6' }}>
                <Tab key='qrcode' title='扫码登录'>
                  <QrCodeLogin loginError={statusError || parseLoginError(loginError)} qrcode={statusError ? '' : qrcode} onRefresh={onRefreshQRCode} isRefreshing={isRefreshingQRCode} loginPhase={loginPhase} isRecoveringLoginService={isRecoveringLoginService} />
                </Tab>
                <Tab key='shortcut' title='快捷登录'>
                  <QuickLogin handleSelectionChange={handleSelectionChange} isLoading={isLoading} qqList={qqList} refresh={refresh} selectedQQ={uinValue} onSubmit={onSubmit} onUpdateQQList={onUpdateQQList} />
                </Tab>
                <Tab key='password' title='密码登录'>
                  <PasswordLogin isLoading={isLoading} onSubmit={onPasswordSubmit} onCaptchaSubmit={onCaptchaSubmit} onNewDeviceVerified={onNewDeviceVerified} qqList={qqList} captchaState={captchaState} captchaVerifying={captchaVerifying} newDeviceState={newDeviceState} onCaptchaCancel={onCaptchaCancel} onNewDeviceCancel={onNewDeviceCancel} />
                </Tab>
              </Tabs>
            </ConsolePanel>
            <div className='flex flex-col gap-5'>
              <ConsolePanel title='登录进度' description='此处跟随真实登录阶段更新。'>
                {[
                  ['准备登录', '获取二维码，或选择历史账号快捷登录。'],
                  ['手机确认', '扫码后请在手机 QQ 上确认本次登录。'],
                  ['核心就绪', '登录成功后初始化服务，并自动进入控制台。'],
                ].map(([title, description], index) => <div key={title} className={`console-step ${phaseIndex === index && !statusError ? 'is-current' : ''}`}><span className='console-step-number'>{index + 1}</span><div><strong>{title}</strong><p>{description}</p></div></div>)}
              </ConsolePanel>
              <div className='console-form-note'><div className='flex items-center gap-2 mb-2 font-semibold'><LuShieldCheck />遇到登录问题？</div>二维码长时间未出现时，请先查看当前错误与运行日志。不要直接删除账号数据或重置设备。GSCore 连接设置可在 QQ 登录前独立配置。<Button size='sm' variant='light' color='primary' className='mt-3' onPress={() => navigate('/logs')}>查看运行日志 →</Button></div>
            </div>
          </div>
        </div>
      </PureLayout>
      {showGUIDManager && (
        <Modal
          title='设备 GUID 管理'
          content={<GUIDManager compact showRestart />}
          size='lg'
          hideFooter
          onClose={() => setShowGUIDManager(false)}
        />
      )}
    </>
  );
}
