import type {
  AttachmentPayload,
  CreateMessageRequest,
  MessageStreamEvent,
  OutputBlockStart,
  StopReason,
  TextCitation,
} from './types.js'
import { readServerSentEvents } from './sse.js'

/**
 * OpenAI 兼容协议的请求体转换与流式解析。
 *
 * 应用内部一直用 Anthropic 形态的事件描述回复，这里把 Chat Completions 与
 * Responses 的请求/流翻译成同一套 MessageStreamEvent，UI 与存储层无需区分协议。
 *
 * 能力对应关系：
 * - 深度思考：completions 用 `reasoning_effort` + `delta.reasoning_content|reasoning`；
 *   responses 用 `reasoning` + `response.reasoning_summary_text.delta`
 * - 联网搜索：completions 用 `web_search_options`；responses 用 `tools: [{type: web_search}]`；
 *   两者的 url_citation 注解都翻译成 citations_delta，界面上照常显示来源
 * - 附件：图片以 data URL 内联（completions 用 image_url，responses 用 input_image）；
 *   responses 的文档用 input_file。completions 不支持文档，会被跳过
 */

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string }

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

/** 思考强度：深度思考开启时使用 */
export const REASONING_EFFORT = 'medium'

const isSearchEnabled = (body: CreateMessageRequest) =>
  (body.tools ?? []).some((tool) => tool.type === 'deepseek_web_search')

/** 文本块拼接（思考块、工具块不参与历史回传） */
const blockText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((block) => {
      if (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 用户消息里的附件块 → data URL 内容片段 */
const attachmentParts = (
  content: unknown,
  attachments: Record<string, AttachmentPayload> | undefined,
  mode: 'chat' | 'responses'
): ContentPart[] => {
  if (!Array.isArray(content) || !attachments) {
    return []
  }
  const parts: ContentPart[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const record = block as { type?: unknown; source?: { file_id?: unknown } }
    const fileID = record.source?.file_id
    if (typeof fileID !== 'string') {
      continue
    }
    const payload = attachments[fileID]
    if (!payload) {
      continue
    }
    if (record.type === 'image') {
      parts.push(
        mode === 'chat'
          ? { type: 'image_url', image_url: { url: payload.dataUrl } }
          : { type: 'input_image', image_url: payload.dataUrl }
      )
    } else if (record.type === 'document' && mode === 'responses') {
      parts.push({
        type: 'input_file',
        filename: payload.filename ?? 'document',
        file_data: payload.dataUrl,
      })
    }
  }
  return parts
}

/** Anthropic 形态的消息 → OpenAI Chat Completions 的 messages */
export const toChatCompletionsMessages = (body: CreateMessageRequest): ChatMessage[] => {
  const messages: ChatMessage[] = []
  if (body.system) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      messages.push({ role: 'system', content: message.content })
      continue
    }
    const text = blockText(message.content)
    const images = message.role === 'user' ? attachmentParts(message.content, body.attachmentData, 'chat') : []
    if (images.length === 0) {
      if (text) {
        messages.push({ role: message.role, content: text })
      }
      continue
    }
    messages.push({
      role: message.role,
      content: [...(text ? [{ type: 'text' as const, text }] : []), ...images],
    })
  }
  return messages
}

export const buildChatCompletionsBody = (body: CreateMessageRequest) => ({
  model: body.model,
  messages: toChatCompletionsMessages(body),
  stream: true,
  ...(body.thinking?.type === 'enabled' ? { reasoning_effort: REASONING_EFFORT } : {}),
  // OpenAI 的搜索开关：让上游用搜索结果作答，并在 delta.annotations 里回引用
  ...(isSearchEnabled(body) ? { web_search_options: { search_context_size: 'medium' } } : {}),
})

export const buildResponsesBody = (body: CreateMessageRequest) => ({
  model: body.model,
  ...(body.system ? { instructions: body.system } : {}),
  input: body.messages
    .filter((message) => message.role !== 'latest_reminder')
    .map((message) => {
      const text = blockText(message.content)
      const parts =
        message.role === 'user' ? attachmentParts(message.content, body.attachmentData, 'responses') : []
      const content: ContentPart[] = [
        ...parts,
        ...(text
          ? [
              {
                type: message.role === 'assistant' ? ('output_text' as const) : ('input_text' as const),
                text,
              },
            ]
          : []),
      ]
      return { role: message.role === 'assistant' ? 'assistant' : 'user', content }
    })
    .filter((item) => item.content.length > 0),
  stream: true,
  ...(body.thinking?.type === 'enabled'
    ? { reasoning: { effort: REASONING_EFFORT, summary: 'auto' } }
    : {}),
  ...(isSearchEnabled(body) ? { tools: [{ type: 'web_search' }] } : {}),
})

const stopReasonFor = (reason: unknown): StopReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

const usageOf = (raw: unknown) => {
  const usage = (raw ?? {}) as { input_tokens?: unknown; output_tokens?: unknown }
  return {
    input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  }
}

/** 块序号分配：思考块在前（若有），文本块在后 */
type StreamState = {
  started: boolean
  finished: boolean
  thinkingIndex: number | null
  textIndex: number | null
  nextIndex: number
  text: string
}

const newState = (): StreamState => ({
  started: false,
  finished: false,
  thinkingIndex: null,
  textIndex: null,
  nextIndex: 0,
  text: '',
})

const emitStart = (state: StreamState, id: string, model: string): MessageStreamEvent[] => {
  if (state.started) {
    return []
  }
  state.started = true
  return [{ type: 'message_start', message: { id, model } }]
}

const closeThinking = (state: StreamState): MessageStreamEvent[] => {
  if (state.thinkingIndex === null) {
    return []
  }
  const index = state.thinkingIndex
  state.thinkingIndex = null
  return [{ type: 'content_block_stop', index }]
}

const openText = (state: StreamState): MessageStreamEvent[] => {
  const events: MessageStreamEvent[] = []
  events.push(...closeThinking(state))
  if (state.textIndex === null) {
    state.textIndex = state.nextIndex++
    events.push({
      type: 'content_block_start',
      index: state.textIndex,
      content_block: { type: 'text', text: '' } as OutputBlockStart,
    })
  }
  return events
}

const emitThinking = (state: StreamState, thinking: string): MessageStreamEvent[] => {
  if (!thinking) {
    return []
  }
  const events: MessageStreamEvent[] = []
  if (state.thinkingIndex === null && state.textIndex !== null) {
    return events
  }
  if (state.thinkingIndex === null) {
    state.thinkingIndex = state.nextIndex++
    events.push({
      type: 'content_block_start',
      index: state.thinkingIndex,
      content_block: { type: 'thinking', thinking: '' } as OutputBlockStart,
    })
  }
  events.push({
    type: 'content_block_delta',
    index: state.thinkingIndex,
    delta: { type: 'thinking_delta', thinking },
  })
  return events
}

const emitText = (state: StreamState, text: string): MessageStreamEvent[] => {
  if (!text) {
    return []
  }
  const events: MessageStreamEvent[] = []
  events.push(...openText(state))
  state.text += text
  events.push({
    type: 'content_block_delta',
    index: state.textIndex as number,
    delta: { type: 'text_delta', text },
  })
  return events
}

/** OpenAI 的 url_citation 注解 → 内部引用事件 */
const emitCitations = (state: StreamState, annotations: unknown): MessageStreamEvent[] => {
  if (!Array.isArray(annotations) || annotations.length === 0) {
    return []
  }
  const events: MessageStreamEvent[] = []
  events.push(...openText(state))
  for (const item of annotations) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const record = item as {
      type?: unknown
      url?: unknown
      title?: unknown
      url_citation?: { url?: unknown; title?: unknown }
    }
    if (record.type !== 'url_citation') {
      continue
    }
    const url = record.url_citation?.url ?? record.url
    if (typeof url !== 'string' || !url) {
      continue
    }
    const rawTitle = record.url_citation?.title ?? record.title
    const citation: TextCitation = {
      type: 'web_search_result_location',
      url,
      title: typeof rawTitle === 'string' && rawTitle ? rawTitle : null,
      cited_text: state.text.trim(),
      encrypted_index: '',
    }
    events.push({
      type: 'content_block_delta',
      index: state.textIndex as number,
      delta: { type: 'citations_delta', citation },
    })
  }
  return events
}

const emitFinish = (state: StreamState, stopReason: unknown, usage: unknown): MessageStreamEvent[] => {
  if (state.finished) {
    return []
  }
  state.finished = true
  const events: MessageStreamEvent[] = []
  events.push(...closeThinking(state))
  if (state.textIndex !== null) {
    events.push({ type: 'content_block_stop', index: state.textIndex })
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(stopReason), stop_sequence: null },
    usage: usageOf(usage),
  })
  events.push({ type: 'message_stop' })
  return events
}

/** 从 Chat Completions 的 delta 里取思考文本：DeepSeek 用 reasoning_content，OpenRouter 用 reasoning */
const reasoningOf = (delta: unknown): string => {
  if (typeof delta !== 'object' || delta === null) {
    return ''
  }
  const record = delta as { reasoning_content?: unknown; reasoning?: unknown }
  if (typeof record.reasoning_content === 'string') {
    return record.reasoning_content
  }
  return typeof record.reasoning === 'string' ? record.reasoning : ''
}

/** POST {base}/chat/completions 的 SSE → MessageStreamEvent */
export async function* streamChatCompletions(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const state = newState()
  for await (const { data } of readServerSentEvents(stream, signal)) {
    if (data.trim() === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const chunk = payload as {
      id?: unknown
      model?: unknown
      choices?: { delta?: unknown; finish_reason?: unknown }[]
      usage?: unknown
    }
    if (typeof chunk.id === 'string') {
      yield* emitStart(state, chunk.id, typeof chunk.model === 'string' ? chunk.model : '')
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta as { content?: unknown; annotations?: unknown } | undefined
    const reasoning = reasoningOf(delta)
    if (reasoning) {
      yield* emitThinking(state, reasoning)
    }
    if (typeof delta?.content === 'string' && delta.content) {
      yield* emitText(state, delta.content)
    }
    if (delta?.annotations) {
      yield* emitCitations(state, delta.annotations)
    }
    if (choice?.finish_reason) {
      yield* emitFinish(state, choice.finish_reason, chunk.usage)
    }
  }
  if (!state.finished) {
    yield* emitFinish(state, 'stop', null)
  }
}

/** POST {base}/responses 的 SSE → MessageStreamEvent */
export async function* streamResponses(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const state = newState()
  let responseID = ''
  let model = ''
  let stopReason: unknown = 'stop'

  for await (const { event, data } of readServerSentEvents(stream, signal)) {
    if (data.trim() === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    const record = (payload ?? {}) as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : event

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = (record.response ?? {}) as { id?: unknown; model?: unknown }
        if (typeof response.id === 'string') {
          responseID = response.id
        }
        if (typeof response.model === 'string') {
          model = response.model
        }
        yield* emitStart(state, responseID, model)
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = record.delta
        if (typeof delta === 'string') {
          yield* emitThinking(state, delta)
        }
        break
      }
      case 'response.output_text.delta': {
        const delta = record.delta
        if (typeof delta === 'string') {
          yield* emitText(state, delta)
        }
        break
      }
      case 'response.output_text.annotation.added': {
        yield* emitCitations(state, [record.annotation])
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = (record.response ?? {}) as {
          usage?: unknown
          incomplete_details?: { reason?: unknown }
        }
        if (response.incomplete_details?.reason) {
          stopReason = response.incomplete_details.reason
        }
        yield* emitFinish(state, stopReason, response.usage ?? null)
        return
      }
      case 'error':
      case 'response.failed': {
        const message = (record.error as { message?: unknown })?.message
        throw new Error(typeof message === 'string' ? message : 'response failed')
      }
      default:
        break
    }
  }
  if (!state.finished) {
    yield* emitFinish(state, stopReason, null)
  }
}
