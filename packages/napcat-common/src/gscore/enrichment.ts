import {
  basicInboundSegment, FORWARD_MARKER, GScoreLimits, identifier, makeGScoreMessage, normalizeMedia, record, safeFileName, validInboundEvent,
  type GSMessage, type GScoreReceive,
} from './protocol';

export type GScoreReadAction = 'get_msg' | 'get_private_file_url' | 'get_forward_msg';
export type GScoreReadCall = (action: GScoreReadAction, params: Record<string, unknown>) => Promise<unknown>;
export interface EnrichmentOptions {
  isCurrent?: () => boolean;
  onDiagnostic?: (message: string) => void;
  lookupTimeoutMs?: number;
  totalTimeoutMs?: number;
}
class EnrichmentLimitError extends Error {}
const lookupId = (value: unknown): string => {
  const id = identifier(value);
  // eslint-disable-next-line no-control-regex -- reject control characters in lookup identifiers
  return id.length > 0 && id.length <= 1024 && !/[\x00-\x1f\x7f]/.test(id) ? id : '';
};

/** Reads context only through a fixed action allowlist; never downloads files itself. */
export async function enrichGScoreMessage (event: unknown, selfId: string, call: GScoreReadCall, options: EnrichmentOptions = {}): Promise<GScoreReceive | undefined> {
  const data = validInboundEvent(event, selfId);
  if (!data) return undefined;
  const current = options.isCurrent ?? (() => true);
  if (!current()) return undefined;
  const start = Date.now();
  const totalTimeout = Math.min(Math.max(options.totalTimeoutMs ?? 10000, 1), 10000);
  const lookupTimeout = Math.min(Math.max(options.lookupTimeoutMs ?? 3000, 1), 5000);
  let lookups = 0;
  let segments = 0;
  const forwards = new Set<string>();
  const replies = new Set<string>();
  const diagnose = (message: string) => { try { options.onDiagnostic?.(message); } catch { /* diagnostics cannot alter forwarding */ } };
  const consume = () => { if (++segments > GScoreLimits.segments) throw new EnrichmentLimitError('引用/合并转发展开后超过 100 个消息段'); };
  const checkCurrent = () => { if (!current()) throw new EnrichmentLimitError('GSCore 连接已变更，丢弃旧消息'); };
  const read = async (action: GScoreReadAction, params: Record<string, unknown>) => {
    checkCurrent();
    if (++lookups > 16) throw new EnrichmentLimitError('消息上下文读取次数超过 16 次');
    const remaining = totalTimeout - (Date.now() - start);
    if (remaining <= 0) throw new Error('消息上下文读取超时');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        call(action, params),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('消息上下文读取超时')), Math.min(remaining, lookupTimeout)); timer.unref?.(); }),
      ]);
      checkCurrent();
      return result;
    } finally { clearTimeout(timer); }
  };
  const fallback = (error: unknown, description: string) => {
    if (error instanceof EnrichmentLimitError) throw error;
    diagnose(description); // do not log message contents, URLs, account IDs or native errors
  };

  const expandForward = async (id: string, depth: number): Promise<GSMessage[]> => {
    if (!id || forwards.has(id) || depth >= GScoreLimits.nodeDepth) return [{ type: 'text', data: FORWARD_MARKER }];
    forwards.add(id);
    try {
      const response = await read('get_forward_msg', { id });
      const envelope = record(response);
      const wrapped = record(envelope?.['data']);
      const messages = Array.isArray(response) ? response : envelope?.['messages'] ?? wrapped?.['messages'];
      if (!Array.isArray(messages) || messages.length > GScoreLimits.segments) throw new Error('转发响应格式无效');
      const output: GSMessage[] = [];
      for (const message of messages) {
        consume();
        const entry = record(message);
        const node = entry?.['type'] === 'node' ? record(entry['data']) : entry;
        if (!node) continue;
        const content = node['content'] ?? node['message'];
        if (typeof content === 'string') {
          if (content.length > GScoreLimits.textChars) throw new EnrichmentLimitError('合并转发文本过长');
          output.push({ type: 'text', data: content });
        } else if (Array.isArray(content)) output.push(...await convert(content, depth + 1, false));
      }
      return output.length ? output : [{ type: 'text', data: FORWARD_MARKER }];
    } catch (error) {
      fallback(error, '合并转发上下文暂不可用，已保留转发标记');
      return [{ type: 'text', data: FORWARD_MARKER }];
    }
  };

  const convert = async (values: unknown[], depth: number, allowReply: boolean): Promise<GSMessage[]> => {
    if (values.length > GScoreLimits.segments) throw new EnrichmentLimitError('消息段数量超过限制');
    const output: GSMessage[] = [];
    for (const value of values) {
      checkCurrent(); consume();
      const segment = record(value); const fields = record(segment?.['data']);
      if (!segment || !fields) continue;
      if (segment['type'] === 'reply') {
        if (!allowReply) continue;
        const id = identifier(fields['id']);
        if (!/^-?\d{1,20}$/.test(id) || replies.has(id)) continue;
        replies.add(id);
        output.push({ type: 'reply_id', data: id });
        try {
          const message = record(await read('get_msg', { message_id: id }));
          if (!message) throw new Error('引用消息不可用');
          if (message['self_id'] !== undefined && identifier(message['self_id']) !== selfId) throw new Error('引用账号不一致');
          if (data['message_type'] === 'group' && message['group_id'] !== undefined && identifier(message['group_id']) !== identifier(data['group_id'])) throw new Error('引用群聊不一致');
          if (data['message_type'] === 'private' && message['group_id']) throw new Error('引用会话不一致');
          if (data['message_type'] === 'private' && message['user_id'] !== undefined && ![identifier(data['user_id']), selfId].includes(identifier(message['user_id']))) throw new Error('引用私聊不一致');
          const quoted = Array.isArray(message['message']) ? await convert(message['message'], depth, false) : [];
          let text = quoted.filter(item => item.type === 'text').map(item => String(item.data)).join('');
          if (!text && typeof message['raw_message'] === 'string') text = message['raw_message'].replace(/\[CQ:[^\]]*\]/g, '').slice(0, GScoreLimits.textChars);
          if (text.length > GScoreLimits.textChars) throw new EnrichmentLimitError('引用文本过长');
          output.push({ type: 'reply', data: text });
          output.push(...quoted.filter(item => ['image', 'record', 'video', 'node'].includes(item.type)));
        } catch (error) {
          fallback(error, '引用消息暂不可用，已保留 reply_id');
          output.push({ type: 'reply', data: '' });
        }
      } else if (segment['type'] === 'forward' || segment['type'] === 'forward_msg') {
        const id = lookupId(fields['id'] ?? fields['message_id'] ?? fields['resid']);
        output.push({ type: 'node', data: await expandForward(id, depth) });
      } else if (segment['type'] === 'node') {
        if (depth >= GScoreLimits.nodeDepth) output.push({ type: 'text', data: FORWARD_MARKER });
        else {
          const content = fields['content'] ?? fields['message'];
          if (Array.isArray(content)) output.push({ type: 'node', data: await convert(content, depth + 1, false) });
          else if (typeof content === 'string' && content.length <= GScoreLimits.textChars) output.push({ type: 'node', data: [{ type: 'text', data: content }] });
        }
      } else if (segment['type'] === 'file') {
        try {
          const name = safeFileName(fields['name'] || fields['file'] || 'file');
          let url = fields['url'];
          if (!url && data['message_type'] === 'private') {
            const fileId = lookupId(fields['file_id'] ?? fields['fid']);
            if (!fileId) throw new Error('文件 ID 缺失');
            const result = record(await read('get_private_file_url', { file_id: fileId, user_id: identifier(data['user_id']) }));
            url = result?.['url'];
          }
          if (!url) throw new Error('文件 URL 缺失');
          output.push({ type: 'file', data: `${name}|${normalizeMedia(url)}` });
        } catch (error) { fallback(error, '文件下载地址暂不可用，已跳过文件段'); }
      } else {
        try {
          const mapped = basicInboundSegment(segment);
          if (!mapped.length) diagnose('不支持的 QQ 消息段已跳过，已识别内容继续转发');
          output.push(...mapped);
        } catch (error) { fallback(error, '不安全或无效的媒体段已跳过'); }
      }
    }
    return output;
  };
  const content = await convert(data['message'] as unknown[], 0, true);
  if (!current()) return undefined;
  return makeGScoreMessage(data, selfId, content);
}
