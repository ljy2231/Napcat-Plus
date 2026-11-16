import { Button } from '@heroui/button';
import { Code } from '@heroui/code';
import { MdError, MdRefresh } from 'react-icons/md';
import { isResourceLoadError, resourceRecoveryMessage } from '@/utils/resource-recovery';

export interface ErrorFallbackProps {
  error: Error
  resetErrorBoundary: () => void
}

function errorFallbackRender ({
  error,
  resetErrorBoundary,
}: ErrorFallbackProps) {
  // A stale build or dropped network surfaces as a failed dynamic import. Reloading
  // is the only real fix; "retry" would re-run the same broken module URL.
  if (isResourceLoadError(error)) {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    return (
      <div className='pt-32 flex flex-col justify-center items-center px-4'>
        <div className='flex items-center'>
          <MdError className='mr-2' color='orange' size={30} />
          <h1 className='text-2xl'>页面资源未能加载</h1>
        </div>
        <div className='my-6 max-w-xl text-center text-sm text-default-600'>
          <p className='mb-2'>{resourceRecoveryMessage(online)}</p>
          <p className='text-default-400'>这不代表你的 QQ 账号或配置有问题；未保存的表单内容会丢失，管理登录凭据会保留。</p>
        </div>
        <Code className='max-w-xl overflow-auto'>{error.message}</Code>
        <Button
          className='mt-6'
          color='primary'
          size='md'
          startContent={<MdRefresh />}
          onPress={() => {
            if (!online) {
              window.alert('当前浏览器处于离线状态，请先恢复网络再刷新。');
              return;
            }
            window.location.reload();
          }}
        >
          刷新页面并重试
        </Button>
      </div>
    );
  }

  return (
    <div className='pt-32 flex flex-col justify-center items-center'>
      <div className='flex items-center'>
        <MdError className='mr-2' color='red' size={30} />
        <h1 className='text-2xl'>出错了</h1>
      </div>
      <div className='my-6 flex flex-col justify-center items-center'>
        <p className='mb-2'>错误信息</p>
        <Code>{error.message}</Code>
      </div>
      <Button color='primary' size='md' onPress={resetErrorBoundary}>
        重试
      </Button>
    </div>
  );
}

export default errorFallbackRender;
