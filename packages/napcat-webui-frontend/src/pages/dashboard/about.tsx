import { Card, CardBody, CardHeader } from '@heroui/card';
import { Chip } from '@heroui/chip';
import { Divider } from '@heroui/divider';
import { Link } from '@heroui/link';
import { Spinner } from '@heroui/spinner';
import { useRequest } from 'ahooks';
import {
  BsCodeSlash,
  BsCpu,
  BsGithub,
  BsGlobe,
  BsPlugin,
  BsTelegram,
} from 'react-icons/bs';
import { IoDocument, IoRocketSharp } from 'react-icons/io5';

import { ConsoleBrand } from '@/components/console-ui';
import { ConsoleUpdatePanel } from '@/components/console-update';
import { DockerUpdatePanel } from '@/components/docker-update';
import ConsoleManager from '@/controllers/console_manager';
import WebUIManager from '@/controllers/webui_manager';

function VersionInfo () {
  const { data, loading, error } = useRequest(WebUIManager.GetNapCatVersion);
  const consoleVersion = useRequest(ConsoleManager.getStatus);

  return (
    <div className='flex items-center gap-2'>
      {error
        ? (
          <Chip color='danger' variant='flat' size='sm'>{error.message}</Chip>
        )
        : loading
          ? (
            <Spinner size='sm' color='default' />
          )
          : (
            <div className='flex items-center gap-2'>
              <Chip size='sm' color='default' variant='flat' className='text-default-500'>Napcat-Plus {consoleVersion.error ? '未知' : consoleVersion.data?.version || '读取中'}</Chip>
              <Chip size='sm' color='primary' variant='flat'>NapCat Core {data?.version}</Chip>
            </div>
          )}
    </div>
  );
}

export default function AboutPage () {
  const features = [
    {
      icon: <IoRocketSharp size={20} />,
      title: '高性能架构',
      desc: 'Node.js + Native 混合架构，资源占用低，响应速度快。',
      className: 'bg-primary-50 text-primary',
    },
    {
      icon: <BsGlobe size={20} />,
      title: '全平台支持',
      desc: '适配 Windows、Linux 及 Docker 环境。',
      className: 'bg-success-50 text-success',
    },
    {
      icon: <BsCodeSlash size={20} />,
      title: 'OneBot 11',
      desc: '深度集成标准协议，兼容现有生态。',
      className: 'bg-warning-50 text-warning',
    },
    {
      icon: <BsPlugin size={20} />,
      title: '极易扩展',
      desc: '提供丰富的 API 接口与 WebHook 支持。',
      className: 'bg-secondary-50 text-secondary',
    },
  ];

  const links = [
    { icon: <BsGithub />, name: 'Napcat-Plus 项目', href: 'https://github.com/ljy2231/Napcat-Plus' },
    { icon: <BsGithub />, name: 'NapCat 上游项目', href: 'https://github.com/NapNeko/NapCatQQ' },
    { icon: <BsTelegram />, name: 'Telegram', href: 'https://t.me/napcatplus' },
    { icon: <IoDocument />, name: '文档', href: 'https://napcat.napneko.icu/' },
  ];

  const cardStyle = 'bg-default/40 backdrop-blur-lg border-none shadow-none';

  return (
    <div className='flex flex-col h-full w-full gap-6 p-2 md:p-6'>
      <title>关于与版本 · Napcat-Plus</title>

      {/* 头部标题区 */}
      <div className='flex flex-col gap-2'>
        <ConsoleBrand />
        <h1 className='text-2xl font-bold text-default-900 mt-3'>关于与版本</h1>
        <div className='flex flex-wrap items-center gap-4 text-small text-default-500'>
          <p>基于 NapCat 的独立增强控制台，非上游官方发行版</p>
          <Divider orientation='vertical' className='h-4' />
          <VersionInfo />
        </div>
      </div>

      <Divider className='opacity-50' />

      {/* 主内容区：双栏布局 */}
      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow'>

        {/* 左侧：介绍与特性 */}
        <div className='lg:col-span-2 space-y-6'>
          <ConsoleUpdatePanel />
          <DockerUpdatePanel />
          <Card shadow='sm' className={cardStyle}>
            <CardHeader className='pb-0 pt-4 px-4 flex-col items-start'>
              <h2 className='text-lg font-bold'>项目简介</h2>
            </CardHeader>
            <CardBody className='py-4 text-default-600 leading-relaxed space-y-2'>
              <p>
                Napcat-Plus 是基于 NapCat 的独立增强版，提供中文优先的管理界面、GSCore 连接管理与运行诊断。
                底层 QQ / OneBot 能力来自 NapCat，保留上游来源与版权声明。
              </p>
              <p>
                本项目不代表 QQ 官方或 NapCat 上游团队。使用与分发请遵循仓库许可证、授权范围及第三方组件许可，
                不要将界面增强理解为无限制的商业使用许可。
              </p>
            </CardBody>
          </Card>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            {features.map((item, index) => (
              <Card key={index} shadow='sm' className={cardStyle}>
                <CardBody className='flex flex-row items-start gap-4 p-4'>
                  <div className={`p-3 rounded-lg ${item.className}`}>
                    {item.icon}
                  </div>
                  <div>
                    <h3 className='font-semibold text-default-900'>{item.title}</h3>
                    <p className='text-small text-default-500 mt-1'>{item.desc}</p>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>

        {/* 右侧：信息与链接 */}
        <div className='space-y-6'>
          <Card shadow='sm' className={cardStyle}>
            <CardHeader className='pb-0 pt-4 px-4'>
              <h2 className='text-lg font-bold'>相关资源</h2>
            </CardHeader>
            <CardBody className='py-4 space-y-4'>
              <div className='flex flex-col gap-2'>
                {links.map((link, idx) => (
                  <Link
                    key={idx}
                    isExternal
                    href={link.href}
                    className='flex items-center justify-between p-3 rounded-xl hover:bg-default-100/50 transition-colors text-default-600'
                  >
                    <span className='flex items-center gap-3'>
                      {link.icon}
                      {link.name}
                    </span>
                    <span className='text-tiny text-default-400'>跳转 &rarr;</span>
                  </Link>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card shadow='sm' className={cardStyle}>
            <CardHeader className='pb-0 pt-4 px-4'>
              <h2 className='text-lg font-bold flex items-center gap-2'>
                <BsCpu /> 技术栈
              </h2>
            </CardHeader>
            <CardBody className='py-4'>
              <div className='flex flex-wrap gap-2'>
                {['TypeScript', 'React', 'Vite', 'Node.js', 'Electron', 'HeroUI'].map((tech) => (
                  <Chip key={tech} size='sm' variant='flat' className='bg-default-100/50 text-default-600'>
                    {tech}
                  </Chip>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* 底部版权 - 移出 grid 布局 */}
      <div className='w-full text-center text-tiny text-default-400 py-4 mt-auto flex flex-col items-center gap-1'>
        <p className='flex items-center justify-center gap-1'>
          Napcat-Plus · 基于 NapCat / NextNapCatWebUI
        </p>
        <p>原作者版权与第三方许可均予保留，详见仓库 LICENSE 与说明。</p>
      </div>
    </div>
  );
}
