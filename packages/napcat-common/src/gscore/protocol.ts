/** GSUID Core wire compatibility, implemented independently of third-party plugins. */
export interface GSMessage { type: string; data: unknown; }
export interface OneBotSegment { type: string; data: Record<string, unknown>; }
export type SendAction = 'send_group_msg' | 'send_private_msg' | 'send_group_forward_msg' | 'send_private_forward_msg' | 'upload_group_file' | 'upload_private_file';
export interface ActionRequest { action: SendAction; params: Record<string, unknown>; }
export interface GScoreReceive {
  bot_id: 'onebot';
  bot_self_id: string;
  msg_id: string;
  user_type: 'group' | 'direct';
  group_id: string | null;
  user_id: string;
  sender: Record<string, unknown>;
  user_pm: number;
  content: GSMessage[];
}

export const GScoreLimits = Object.freeze({ payloadBytes: 16 * 1024 * 1024, mediaChars: 14 * 1024 * 1024, textChars: 20000, segments: 100, nodeDepth: 3, actions: 20 });
export const FORWARD_MARKER = '[合并转发]';
export const UNSUPPORTED_GSCORE_FEATURES = Object.freeze(['notice/meta', 'recall receipts', 'excute_delete_message', 'excute_ban_user', 'arbitrary API actions', 'buttons/templates']);

export function record (value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function identifier (value: unknown): string {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}
export function assertPayloadSize (value: unknown): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new Error('GSCore 消息不是有界 JSON 数据'); }
  if (json === undefined || Buffer.byteLength(json) > GScoreLimits.payloadBytes) throw new Error('GSCore 消息超过 16 MiB 限制');
}
export function safeFileName (value: unknown): string {
  // Reject ASCII control characters rather than allowing them into filesystem names.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\x00-\x1f\x7f/\\|:]/.test(value) || value.trim() === '.' || value.trim() === '..') throw new Error('文件名无效');
  return value.trim();
}

/** A bare base64 value always becomes bytes, never a relative/local file path. */
export function normalizeMedia (value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > GScoreLimits.mediaChars) throw new Error('媒体参数无效或过大');
  let source = value.trim();
  if (source.startsWith('link://')) {
    source = source.slice(7);
    if (!/^https?:\/\//i.test(source)) throw new Error('link:// 仅支持 HTTP(S)');
  }
  if (/^https?:\/\//i.test(source)) {
    let url: URL;
    try { url = new URL(source); } catch { throw new Error('媒体 URL 无效'); }
    // eslint-disable-next-line no-control-regex -- credentials/control characters must not enter a media URL
    if (!url.hostname || url.username || url.password || /[\x00-\x20\x7f\\]/.test(source)) throw new Error('媒体 URL 无效或含凭据');
    return url.toString();
  }
  const explicitBase64 = source.startsWith('base64://');
  if (!explicitBase64 && (/^(?:\.{1,2}[\\/]|~[\\/]|[A-Za-z]:|\\\\)/.test(source) || (source.startsWith('/') && !source.startsWith('/9j/')))) throw new Error('禁止本机文件路径；歧义二进制请使用 base64:// 前缀');
  const encoded = explicitBase64 ? source.slice(9) : source;
  // Validate canonical, padded base64. Reject paths, data URLs, unsupported schemes,
  // malformed padding, and strings that would otherwise be passed as file paths.
  const compact = encoded.replace(/[\r\n]/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('仅支持 HTTP(S)、link://HTTP(S) 或有效 base64；禁止本机文件路径');
  if (Buffer.from(compact, 'base64').toString('base64') !== compact) throw new Error('base64 编码无效');
  return 'base64://' + compact;
}

export function validInboundEvent (event: unknown, selfId: string): Record<string, unknown> | undefined {
  const data = record(event);
  if (!data || data['post_type'] !== 'message' || !['group', 'private'].includes(String(data['message_type']))) return undefined;
  if (data['self_id'] !== undefined && identifier(data['self_id']) !== selfId) return undefined;
  if (identifier(data['user_id']) === selfId || !/^\d{1,20}$/.test(identifier(data['user_id']))) return undefined;
  if (data['message_type'] === 'group' && !/^\d{1,20}$/.test(identifier(data['group_id']))) return undefined;
  if (!Array.isArray(data['message'])) return undefined;
  assertPayloadSize(data);
  if (data['message'].length > GScoreLimits.segments) throw new Error('QQ 消息段超过限制');
  return data;
}

export function basicInboundSegment (segment: unknown): GSMessage[] {
  const data = record(segment); const fields = record(data?.['data']);
  if (!data || !fields) return [];
  switch (data['type']) {
    case 'text': {
      const text = fields['text'];
      if (typeof text !== 'string' || text.length > GScoreLimits.textChars) throw new Error('QQ 文本无效或过长');
      return [{ type: 'text', data: text }];
    }
    case 'at': {
      const id = identifier(fields['qq']);
      return id === 'all' || /^\d{1,20}$/.test(id) ? [{ type: 'at', data: id }] : [];
    }
    case 'face': return [{ type: 'text', data: `[表情:${identifier(fields['id']).slice(0, 20)}]` }];
    case 'reply': {
      const id = identifier(fields['id']);
      return /^-?\d{1,20}$/.test(id) ? [{ type: 'reply_id', data: id }, { type: 'reply', data: '' }] : [];
    }
    case 'image': case 'record': case 'video':
      return [{ type: String(data['type']), data: normalizeMedia(fields['url'] || fields['file']) }];
    case 'file': {
      if (!fields['url']) return [];
      return [{ type: 'file', data: `${safeFileName(fields['name'] || fields['file'] || 'file')}|${normalizeMedia(fields['url'])}` }];
    }
    case 'forward': case 'forward_msg': case 'node': return [{ type: 'text', data: FORWARD_MARKER }];
    default: return [];
  }
}

export function makeGScoreMessage (event: Record<string, unknown>, selfId: string, content: GSMessage[]): GScoreReceive | undefined {
  if (!content.length) return undefined;
  let count = 0;
  const check = (items: GSMessage[], depth: number) => {
    if (depth > GScoreLimits.nodeDepth) throw new Error('GSCore 展开节点深度超过限制');
    for (const item of items) {
      if (++count > GScoreLimits.segments) throw new Error('GSCore 展开消息段总数超过 100');
      if (item.type === 'node') {
        if (!Array.isArray(item.data)) throw new Error('GSCore 展开节点格式无效');
        check(item.data, depth + 1);
      }
    }
  };
  check(content, 0);
  const sender = record(event['sender']) || {};
  const role = sender['role'];
  const message: GScoreReceive = {
    bot_id: 'onebot',
    bot_self_id: selfId,
    msg_id: identifier(event['message_id']),
    user_type: event['message_type'] === 'group' ? 'group' : 'direct',
    group_id: event['message_type'] === 'group' ? identifier(event['group_id']) : null,
    user_id: identifier(event['user_id']),
    sender,
    user_pm: role === 'owner' ? 2 : role === 'admin' ? 3 : 6,
    content,
  };
  assertPayloadSize(message);
  return message;
}

/** Synchronous basic mapper. The production adapter uses enrichment for lookups. */
export function toGScoreMessage (event: unknown, selfId: string): GScoreReceive | undefined {
  const data = validInboundEvent(event, selfId);
  if (!data) return undefined;
  return makeGScoreMessage(data, selfId, (data['message'] as unknown[]).flatMap(basicInboundSegment));
}

interface Budget { segments: number; }
function consume (budget: Budget): void {
  if (++budget.segments > GScoreLimits.segments) throw new Error('GSCore 消息段总数超过 100');
}
function segmentArray (value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > GScoreLimits.segments) throw new Error('消息内容需包含 1–100 个消息段');
  return value;
}
function scalarSegment (segment: Record<string, unknown>): OneBotSegment {
  const data = segment['data'];
  switch (segment['type']) {
    case 'text': case 'markdown':
      if (typeof data !== 'string' || data.length > GScoreLimits.textChars) throw new Error('文本无效或过长');
      return { type: 'text', data: { text: data } };
    case 'at': {
      const id = identifier(data);
      if (id !== 'all' && !/^\d{1,20}$/.test(id)) throw new Error('无效的 @ 目标');
      return { type: 'at', data: { qq: id } };
    }
    case 'reply': case 'reply_id': {
      const id = identifier(data);
      if (!/^-?\d{1,20}$/.test(id)) throw new Error('无效的引用消息 ID');
      return { type: 'reply', data: { id } };
    }
    case 'image': case 'record': case 'video': return { type: String(segment['type']), data: { file: normalizeMedia(data) } };
    case 'file': {
      if (typeof data !== 'string') throw new Error('文件参数无效');
      const separator = data.indexOf('|');
      if (separator < 1) throw new Error('文件格式应为 name|url 或 name|base64');
      return { type: 'file', data: { name: safeFileName(data.slice(0, separator)), file: normalizeMedia(data.slice(separator + 1)) } };
    }
    default: throw new Error('不支持的 GSCore 消息类型（控制动作、notice/meta、按钮模板暂不支持）');
  }
}

function forwardNodes (value: unknown, selfId: string, depth: number, budget: Budget): OneBotSegment[] {
  if (depth > GScoreLimits.nodeDepth) throw new Error('合并转发深度超过 3 层');
  return segmentArray(value).map((child) => {
    const segment = record(child);
    if (!segment) throw new Error('合并转发消息段无效');
    consume(budget);
    const content = segment['type'] === 'node'
      ? forwardNodes(segment['data'], selfId, depth + 1, budget)
      : [scalarSegment(segment)];
    return { type: 'node', data: { user_id: selfId, nickname: 'Napcat-Plus', content } };
  });
}

/** Validate the entire packet before returning a bounded, ordered send-only plan. */
export function fromGScoreMessages (message: unknown, selfId: string): ActionRequest[] {
  const value = record(message);
  if (!value) throw new Error('GSCore 消息必须为对象');
  assertPayloadSize(value);
  if (value['bot_self_id'] !== undefined && value['bot_self_id'] !== '' && identifier(value['bot_self_id']) !== selfId) throw new Error('消息不属于当前账号');
  if (value['bot_id'] !== undefined && value['bot_id'] !== '' && value['bot_id'] !== 'onebot' && value['bot_id'] !== 'napcat') throw new Error('不支持的机器人协议');
  if (value['action'] !== undefined) throw new Error('GSCore 任意 API 动作暂不支持');
  const group = value['target_type'] === 'group';
  if (!group && !['direct', 'private'].includes(String(value['target_type']))) throw new Error('不支持的目标类型');
  const id = identifier(value['target_id']);
  if (!/^\d{1,20}$/.test(id)) throw new Error('目标 ID 无效');
  const target = group ? { group_id: id } : { user_id: id };
  const budget: Budget = { segments: 0 };
  const plan: ActionRequest[] = [];
  let normal: OneBotSegment[] = [];
  const push = (request: ActionRequest) => {
    if (plan.length >= GScoreLimits.actions) throw new Error('GSCore 单包发送动作超过 20 次');
    plan.push(request);
  };
  const flush = () => {
    if (!normal.length) return;
    push({ action: group ? 'send_group_msg' : 'send_private_msg', params: { ...target, message: normal } });
    normal = [];
  };
  for (const item of segmentArray(value['content'])) {
    const segment = record(item);
    if (!segment) throw new Error('消息段无效');
    consume(budget);
    if (segment['type'] === 'node') {
      flush();
      push({ action: group ? 'send_group_forward_msg' : 'send_private_forward_msg', params: { ...target, messages: forwardNodes(segment['data'], selfId, 1, budget) } });
    } else if (segment['type'] === 'file') {
      flush();
      const file = scalarSegment(segment);
      push({ action: group ? 'upload_group_file' : 'upload_private_file', params: { ...target, ...file.data } });
    } else normal.push(scalarSegment(segment));
  }
  flush();
  assertPayloadSize(plan);
  return plan;
}

/** Legacy single-action helper deliberately refuses to discard a mixed suffix. */
export function fromGScoreMessage (message: unknown, selfId: string): ActionRequest {
  const plan = fromGScoreMessages(message, selfId);
  if (plan.length !== 1) throw new Error('混合消息包含多个动作，请使用 fromGScoreMessages');
  return plan[0]!;
}
