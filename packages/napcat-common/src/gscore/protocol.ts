/** GSUID Core MessageReceive/MessageSend wire format; independently implemented. */
export interface GSMessage { type: string; data: unknown; }
export interface OneBotSegment { type: string; data: Record<string, unknown>; }
export interface ActionRequest { action: 'send_group_msg' | 'send_private_msg' | 'send_group_forward_msg' | 'send_private_forward_msg' | 'upload_group_file' | 'upload_private_file'; params: Record<string, unknown>; }

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export function toGScoreMessage (event: unknown, selfId: string) {
  const data = object(event);
  if (!data || data['post_type'] !== 'message' || !['group', 'private'].includes(String(data['message_type']))) return undefined;
  if (identifier(data['user_id']) === selfId) return undefined;
  if (!Array.isArray(data['message'])) return undefined;
  const content: GSMessage[] = [];
  for (const value of data['message'].slice(0, 100)) {
    const segment = object(value); const fields = object(segment?.['data']);
    if (!segment || !fields) continue;
    switch (segment['type']) {
      case 'text': content.push({ type: 'text', data: String(fields['text'] ?? '') }); break;
      case 'at': content.push({ type: 'at', data: identifier(fields['qq']) }); break;
      case 'reply': content.push({ type: 'reply', data: identifier(fields['id']) }); break;
      case 'image': case 'record': case 'video':
        content.push({ type: String(segment['type']), data: String(fields['url'] || fields['file'] || '') }); break;
      case 'file': content.push({ type: 'file', data: `${String(fields['name'] || 'file')}|${String(fields['url'] || '')}` }); break;
      default: break;
    }
  }
  if (!content.length) return undefined;
  const sender = object(data['sender']) || {};
  const role = sender['role'];
  return {
    bot_id: 'onebot',
    bot_self_id: selfId,
    msg_id: identifier(data['message_id']),
    user_type: data['message_type'] === 'group' ? 'group' : 'direct',
    group_id: data['message_type'] === 'group' ? identifier(data['group_id']) : null,
    user_id: identifier(data['user_id']),
    sender,
    user_pm: role === 'owner' ? 2 : role === 'admin' ? 3 : 6,
    content,
  };
}

function media (value: unknown): string {
  if (typeof value !== 'string' || value.length > 14 * 1024 * 1024) throw new Error('媒体参数无效');
  if (/^base64:\/\/[A-Za-z0-9+/=\r\n]+$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('仅支持 HTTP(S) 或 base64 媒体，禁止读取本机文件'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的媒体地址');
  return value;
}

function toSegments (content: unknown): OneBotSegment[] {
  if (!Array.isArray(content) || content.length === 0 || content.length > 100) throw new Error('消息内容需包含 1–100 个消息段');
  return content.map((item) => {
    const segment = object(item);
    if (!segment) throw new Error('消息段无效');
    const data = segment['data'];
    switch (segment['type']) {
      case 'text':
        if (typeof data !== 'string' || data.length > 20000) throw new Error('文本无效或过长');
        return { type: 'text', data: { text: data } };
      case 'at': {
        const id = identifier(data);
        if (id !== 'all' && !/^\d{1,20}$/.test(id)) throw new Error('无效的 @ 目标');
        return { type: 'at', data: { qq: id } };
      }
      case 'reply': {
        const id = identifier(data);
        if (!/^-?\d{1,20}$/.test(id)) throw new Error('无效的引用消息');
        return { type: 'reply', data: { id } };
      }
      case 'image': case 'record': case 'video':
        return { type: String(segment['type']), data: { file: media(data) } };
      default: throw new Error('不支持的 GSCore 消息段');
    }
  });
}

export function fromGScoreMessage (message: unknown, selfId: string): ActionRequest {
  const value = object(message);
  if (!value) throw new Error('GSCore 消息必须为对象');
  if (value['bot_self_id'] && identifier(value['bot_self_id']) !== selfId) throw new Error('消息不属于当前账号');
  if (value['bot_id'] && value['bot_id'] !== 'onebot' && value['bot_id'] !== 'napcat') throw new Error('不支持的机器人协议');
  const group = value['target_type'] === 'group';
  if (!group && !['direct', 'private'].includes(String(value['target_type']))) throw new Error('不支持的目标类型');
  const id = identifier(value['target_id']);
  if (!/^\d{1,20}$/.test(id)) throw new Error('目标 ID 无效');
  const target = group ? { group_id: id } : { user_id: id };
  const content = value['content'];
  if (Array.isArray(content) && content.length === 1) {
    const first = object(content[0]);
    if (first?.['type'] === 'node') {
      if (!Array.isArray(first['data']) || first['data'].length === 0 || first['data'].length > 100) throw new Error('合并转发无效');
      const nodes = first['data'].map((child) => ({ type: 'node', data: { user_id: selfId, nickname: 'QQ Bot Console', content: toSegments([child]) } }));
      return { action: group ? 'send_group_forward_msg' : 'send_private_forward_msg', params: { ...target, messages: nodes } };
    }
    if (first?.['type'] === 'file') {
      if (typeof first['data'] !== 'string') throw new Error('文件参数无效');
      const index = first['data'].indexOf('|');
      if (index < 1) throw new Error('文件格式应为 name|url');
      const name = first['data'].slice(0, index);
      if (name.length > 255 || /[\r\n/\\]/.test(name)) throw new Error('文件名无效');
      return { action: group ? 'upload_group_file' : 'upload_private_file', params: { ...target, name, file: media(first['data'].slice(index + 1)) } };
    }
  }
  return { action: group ? 'send_group_msg' : 'send_private_msg', params: { ...target, message: toSegments(content) } };
}
