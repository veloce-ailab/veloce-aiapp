import type {
  CreateMessageRequest,
  MessageStreamEvent,
  OutputBlockStart,
  StopReason,
} from './types.js'
import { readServerSentEvents } from './sse.js'

/**
 * OpenAI 兼容协议的请求体转换与流式解析。
 *
 * 应用内部一直用 Anthropic 形态的事件描述回复，所以这里把 Chat Completions
 * 与 Responses 的流翻译成同一套 MessageStreamEvent，UI 与存储层无需区分协议。
 *
 * 深度思考同样会翻译：Chat Completions 用 `reasoning_effort` 请求、
 * 从 `delta.reasoning_content`（DeepSeek / vLLM）或 `delta.reasoning`
 * （OpenRouter）读取思考内容；Responses 用 `reasoning` 请求、
 * 从 `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` 读取。
 * 思考块排在文本块前面，与 Claude 协议一致。
 */

type ChatCompletionsMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** 思考强度：深度思考开启时使用，两家协议字段名不同但取值一致 */
export const REASONING_EFFORT = 'medium'

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

/** Anthropic 形态的消息 → OpenAI Chat Completions 的 messages（思考块不回传） */
export const toChatCompletionsMessages = (body: CreateMessageRequest): ChatCompletionsMessage[] => {
  const messages: ChatCompletionsMessage[] = []
  if (body.system) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      messages.push({ role: 'system', content: message.content })
      continue
    }
    const content = blockText(message.content)
    if (!content) {
      continue
    }
    messages.push({ role: message.role, content })
  }
  return messages
}

export const buildChatCompletionsBody = (body: CreateMessageRequest) => ({
  model: body.model,
  messages: toChatCompletionsMessages(body),
  stream: true,
  ...(body.thinking?.type === 'enabled' ? { reasoning_effort: REASONING_EFFORT } : {}),
})

export const buildResponsesBody = (body: CreateMessageRequest) => ({
  model: body.model,
  ...(body.system ? { instructions: body.system } : {}),
  input: body.messages
    .filter((message) => message.role !== 'latest_reminder')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: blockText(message.content),
        },
      ],
    }))
    .filter((item) => item.content[0].text),
  stream: true,
  ...(body.thinking?.type === 'enabled'
    ? { reasoning: { effort: REASONING_EFFORT, summary: 'auto' } }
    : {}),
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
}

const newState = (): StreamState => ({
  started: false,
  finished: false,
  thinkingIndex: null,
  textIndex: null,
  nextIndex: 0,
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

const emitThinking = (state: StreamState, text: string): MessageStreamEvent[] => {
  if (!text) {
    return []
  }
  const events: MessageStreamEvent[] = []
  if (state.thinkingIndex === null && state.textIndex !== null) {
    // 文本已经开始后再来思考内容，忽略（正常顺序不会出现）
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
    delta: { type: 'thinking_delta', thinking: text },
  })
  return events
}

const emitText = (state: StreamState, text: string): MessageStreamEvent[] => {
  if (!text) {
    return []
  }
  const events: MessageStreamEvent[] = []
  // 文本开始时结束思考块
  events.push(...closeThinking(state))
  if (state.textIndex === null) {
    state.textIndex = state.nextIndex++
    events.push({
      type: 'content_block_start',
      index: state.textIndex,
      content_block: { type: 'text', text: '' } as OutputBlockStart,
    })
  }
  events.push({
    type: 'content_block_delta',
    index: state.textIndex,
    delta: { type: 'text_delta', text },
  })
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
  if (typeof record.reasoning === 'string') {
    return record.reasoning
  }
  return ''
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
    const reasoning = reasoningOf(choice?.delta)
    if (reasoning) {
      yield* emitThinking(state, reasoning)
    }
    const delta = choice?.delta as { content?: unknown } | undefined
    if (typeof delta?.content === 'string' && delta.content) {
      yield* emitText(state, delta.content)
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
  let lastUsage: unknown = null
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
        if (typeof delta === 'string' && delta) {
          yield* emitThinking(state, delta)
        }
        break
      }
      case 'response.output_text.delta': {
        const delta = record.delta
        if (typeof delta === 'string' && delta) {
          yield* emitText(state, delta)
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = (record.response ?? {}) as {
          usage?: unknown
          incomplete_details?: { reason?: unknown }
        }
        lastUsage = response.usage ?? null
        if (response.incomplete_details?.reason) {
          stopReason = response.incomplete_details.reason
        }
        yield* emitFinish(state, stopReason, lastUsage)
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
    yield* emitFinish(state, stopReason, lastUsage)
  }
}
