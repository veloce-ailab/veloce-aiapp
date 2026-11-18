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
 * 只翻译文本内容：deepseek_web_search、thinking、safety_check、附件等扩展能力
 * 仅在 claude 协议下可用。
 */

type ChatCompletionsMessage = { role: 'system' | 'user' | 'assistant'; content: string }

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

/** Anthropic 形态的消息 → OpenAI Chat Completions 的 messages */
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
    messages.push({ role: message.role, content: blockText(message.content) })
  }
  return messages
}

export const buildChatCompletionsBody = (body: CreateMessageRequest) => ({
  model: body.model,
  messages: toChatCompletionsMessages(body),
  stream: true,
  ...(body.thinking?.type === 'enabled' ? { reasoning_effort: 'medium' } : {}),
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
    })),
  stream: true,
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
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  return {
    input_tokens: input,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: output,
  }
}

type TextStreamState = {
  started: boolean
  blockOpen: boolean
  finished: boolean
}

/** 依次产出：message_start → content_block_start → text_delta… → 收尾事件 */
const emitStart = (state: TextStreamState, id: string, model: string): MessageStreamEvent[] => {
  if (state.started) {
    return []
  }
  state.started = true
  return [{ type: 'message_start', message: { id, model } }]
}

const emitText = (state: TextStreamState, text: string, index = 0): MessageStreamEvent[] => {
  const events: MessageStreamEvent[] = []
  if (!state.started) {
    events.push(...emitStart(state, '', ''))
  }
  if (!state.blockOpen) {
    state.blockOpen = true
    events.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' } as OutputBlockStart,
    })
  }
  events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
  return events
}

const emitFinish = (
  state: TextStreamState,
  stopReason: unknown,
  usage: unknown,
  index = 0
): MessageStreamEvent[] => {
  if (state.finished) {
    return []
  }
  state.finished = true
  const events: MessageStreamEvent[] = []
  if (state.blockOpen) {
    events.push({ type: 'content_block_stop', index })
  }
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReasonFor(stopReason), stop_sequence: null },
    usage: usageOf(usage),
  })
  events.push({ type: 'message_stop' })
  return events
}

/** POST {base}/chat/completions 的 SSE → MessageStreamEvent */
export async function* streamChatCompletions(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const state: TextStreamState = { started: false, blockOpen: false, finished: false }
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
      choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[]
      usage?: unknown
    }
    if (typeof chunk.id === 'string') {
      const startEvents = emitStart(
        state,
        chunk.id,
        typeof chunk.model === 'string' ? chunk.model : ''
      )
      if (startEvents.length) {
        yield* startEvents
      }
    }
    const choice = chunk.choices?.[0]
    const text = choice?.delta?.content
    if (typeof text === 'string' && text) {
      yield* emitText(state, text)
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
  const state: TextStreamState = { started: false, blockOpen: false, finished: false }
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

    if (type === 'response.created' || type === 'response.in_progress') {
      const response = (record.response ?? {}) as { id?: unknown; model?: unknown; usage?: unknown }
      if (typeof response.id === 'string') {
        responseID = response.id
      }
      if (typeof response.model === 'string') {
        model = response.model
      }
      yield* emitStart(state, responseID, model)
      continue
    }

    if (type === 'response.output_text.delta') {
      const delta = record.delta
      if (typeof delta === 'string' && delta) {
        yield* emitText(state, delta)
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = (record.response ?? {}) as {
        usage?: unknown
        status?: unknown
        incomplete_details?: { reason?: unknown }
      }
      lastUsage = response.usage ?? null
      if (response.incomplete_details?.reason) {
        stopReason = response.incomplete_details.reason
      }
      yield* emitFinish(state, stopReason, lastUsage)
      return
    }

    if (type === 'error' || type === 'response.failed') {
      const message = (record.error as { message?: unknown })?.message
      throw new Error(typeof message === 'string' ? message : 'response failed')
    }
  }
  if (!state.finished) {
    yield* emitFinish(state, stopReason, lastUsage)
  }
}
