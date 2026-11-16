import { Button } from '@heroui/button';
import { Input } from '@heroui/input';
import { useLocalStorage } from '@uidotdev/usehooks';
import { useEffect, useRef, useState } from 'react';
import { LuArrowLeft, LuArrowRight, LuCable, LuFingerprint, LuKeyRound, LuLayoutDashboard, LuShieldCheck } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import key from '@/const/key';
import WebUIManager from '@/controllers/webui_manager';
import PureLayout from '@/layouts/pure';

const PASSKEY_TIMEOUT_MS = 30_000;
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const encode = (value: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

export default function WebLoginPage () {
  const initialToken = useRef(new URLSearchParams(window.location.search).get('token') || '');
  const navigate = useNavigate();
  const [token, setToken] = useState(initialToken.current);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [require2FA, setRequire2FA] = useState(false);
  const [totp, setTotp] = useState('');
  const [pendingToken, setPendingToken] = useState('');
  const [error, setError] = useState('');
  const [, setCredential] = useLocalStorage<string>(key.token, '');
  const abort = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);

  const submit = async (inputToken = token, code?: string) => {
    if (submitting.current) return;
    if (!inputToken.trim()) { setError('请输入管理 Token。'); return; }
    if (require2FA && (!code || !/^\d{6}$/.test(code))) { setError('请输入验证器中的 6 位验证码。'); return; }
    abort.current?.abort();
    submitting.current = true; setLoading(true); setError('');
    try {
      const data = await WebUIManager.loginWithToken(inputToken, code);
      if (!mounted.current) return;
      if (data?.require2FA) { setRequire2FA(true); setPendingToken(inputToken); return; }
      if (!data?.Credential) throw new Error('服务未返回有效的管理凭据，请重试。');
      setCredential(data.Credential);
      // Remove bootstrap tokens from browser history after successful auth.
      navigate('/', { replace: true });
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { submitting.current = false; if (mounted.current) setLoading(false); }
  };

  const passkey = async () => {
    if (abort.current || loading || passkeyLoading) return;
    if (!navigator.credentials?.get) { setError('当前浏览器或连接环境不支持 Passkey，请使用 Token 登录。'); return; }
    const controller = new AbortController(); abort.current = controller;
    const timer = setTimeout(() => controller.abort(), PASSKEY_TIMEOUT_MS);
    setPasskeyLoading(true); setError('');
    try {
      const options = await WebUIManager.generatePasskeyAuthenticationOptions();
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: decode(options.challenge) as BufferSource,
          allowCredentials: options.allowCredentials?.map((item: { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[]; }) => ({ ...item, id: decode(item.id) as BufferSource })),
          userVerification: options.userVerification,
          timeout: PASSKEY_TIMEOUT_MS,
        },
        signal: controller.signal,
      }) as PublicKeyCredential | null;
      if (!credential) throw new Error('Passkey 验证已取消。');
      const response = credential.response as AuthenticatorAssertionResponse;
      const data = await WebUIManager.verifyPasskeyAuthentication({
        id: credential.id, rawId: encode(credential.rawId), type: credential.type,
        response: { authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null },
      });
      if (controller.signal.aborted || !mounted.current) return;
      if (!data?.Credential) throw new Error('Passkey 验证未返回管理凭据。');
      setCredential(data.Credential); navigate('/', { replace: true });
    } catch (cause) {
      if (mounted.current && !submitting.current) setError(controller.signal.aborted ? 'Passkey 验证超时或已取消，可以使用 Token 继续。' : (cause as Error).message);
    } finally {
      clearTimeout(timer);
      if (abort.current === controller) abort.current = null;
      if (mounted.current) setPasskeyLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    if (initialToken.current) void submit(initialToken.current);
    return () => { mounted.current = false; abort.current?.abort(); };
  }, []);

  return <>
    <title>管理登录 · QQ Bot Console</title>
    <PureLayout>
      <div className='console-auth-grid'>
        <section className='console-auth-story'>
          <span className='console-eyebrow'>YOUR BOT, UNDER CONTROL</span>
          <h1>让每一次连接，<br /><span>清晰可见。</span></h1>
          <p>从 QQ 登录到 GSCore 消息桥接，在一个清晰、可靠的控制台中管理你的机器人。</p>
          <div className='console-auth-features'>
            <div className='console-auth-feature'><LuLayoutDashboard /><div><strong>一个工作空间</strong><p>连接、日志、插件与文件管理，保留熟悉的能力。</p></div></div>
            <div className='console-auth-feature'><LuCable /><div><strong>连接状态不再靠猜</strong><p>QQ 与 GSCore 分开诊断，问题直达处理入口。</p></div></div>
            <div className='console-auth-feature'><LuShieldCheck /><div><strong>凭据安全优先</strong><p>沿用服务端鉴权，支持 Passkey 与两步验证。</p></div></div>
          </div>
        </section>
        <section className='console-auth-card' aria-labelledby='auth-heading'>
          <span className='console-eyebrow'>SECURE ACCESS</span>
          <h2 id='auth-heading'>{require2FA ? '两步验证' : '登录管理控制台'}</h2>
          <p className='console-auth-card-subtitle'>{require2FA ? '请输入验证器应用中的动态验证码，完成本次管理登录。' : '使用启动日志中的 WebUI Token 登录。这不是你的 QQ 密码。'}</p>
          <form className='flex flex-col gap-5' onSubmit={(event) => { event.preventDefault(); void submit(require2FA ? pendingToken : token, require2FA ? totp : undefined); }}>
            <input className='sr-only' aria-label='管理账号' type='text' name='username' value='qq-bot-console' readOnly autoComplete='username' tabIndex={-1} />
            {require2FA ? <Input autoFocus type='text' inputMode='numeric' pattern='[0-9]{6}' maxLength={6} autoComplete='one-time-code' label='动态验证码' labelPlacement='outside' placeholder='输入 6 位验证码' variant='bordered' size='lg' value={totp} onValueChange={(value) => setTotp(value.replace(/\D/g, ''))} isDisabled={loading} /> : <Input type='password' name='password' autoComplete='current-password' label='管理 Token' labelPlacement='outside' placeholder='输入你的 WebUI Token' variant='bordered' size='lg' value={token} onValueChange={setToken} isDisabled={loading} startContent={<LuKeyRound className='text-default-400' />} />}
            {error && <p className='text-danger text-xs leading-relaxed break-words' role='alert'>{error}</p>}
            <Button type='submit' size='lg' color='primary' isLoading={loading} endContent={!loading && <LuArrowRight />}>{require2FA ? '验证并进入控制台' : '进入控制台'}</Button>
          </form>
          {require2FA ? <Button variant='light' className='mt-5' size='sm' startContent={<LuArrowLeft />} isDisabled={loading} onPress={() => { setRequire2FA(false); setTotp(''); setPendingToken(''); setError(''); }}>返回 Token 登录</Button> : <>
            <div className='flex items-center gap-3 my-6 text-[10px] text-default-400'><span className='h-px bg-divider flex-1' />其他登录方式<span className='h-px bg-divider flex-1' /></div>
            <Button className='w-full' variant='bordered' size='lg' onPress={passkey} isDisabled={loading} isLoading={passkeyLoading} startContent={!passkeyLoading && <LuFingerprint size={19} />}>使用 Passkey</Button>
            {passkeyLoading && <p className='mt-3 text-xs text-default-500' role='status'>等待设备验证，最多 30 秒。也可直接使用 Token。</p>}
          </>}
          <p className='mt-6 text-[11px] text-default-500 leading-relaxed'>请仅在可信设备上登录。管理凭据可以访问机器人配置和文件，切勿公开分享。</p>
        </section>
      </div>
    </PureLayout>
  </>;
}
