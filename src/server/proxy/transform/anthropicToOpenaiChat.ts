/**
 * Request transformation: Anthropic Messages → OpenAI Chat Completions
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import type {
  AnthropicRequest,
  AnthropicContentBlock,
  AnthropicMessage,
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIChatContentPart,
  OpenAIToolCall,
  OpenAITool,
} from './types.js'

/**
 * Convert Anthropic Messages request to OpenAI Chat Completions request.
 */
export function anthropicToOpenaiChat(body: AnthropicRequest): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = []

  // Convert system prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system })
    } else if (Array.isArray(body.system)) {
      const text = body.system.map((b) => b.text).join('\n')
      messages.push({ role: 'system', content: text })
    }
  }

  // Convert messages
  for (const msg of body.messages) {
    convertMessage(msg, messages, body.model)
  }

  // Build request
  const result: OpenAIChatRequest = {
    model: body.model,
    messages,
    stream: body.stream,
  }

  // max_tokens — limit for DeepSeek to avoid invalid parameter errors
  if (body.max_tokens !== undefined) {
    if (body.model.toLowerCase().includes('deepseek')) {
      // DeepSeek R1 often fails if max_tokens is set to Claude's high defaults (like 128k)
      // Especially when tools or thinking are involved. 8192 is a safe upper limit for most.
      result.max_tokens = Math.min(body.max_tokens, 8192)
    } else {
      result.max_tokens = body.max_tokens
    }
  }

  // temperature & top_p
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p

  // stop_sequences → stop
  if (body.stop_sequences && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences
  }

  // tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools
      .filter((t) => t.name !== 'BatchTool')
      .map((t): OpenAITool => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  // thinking → reasoning_effort
  if (body.thinking && !body.model.toLowerCase().includes('deepseek')) {
    const budget = body.thinking.budget_tokens
    if (budget !== undefined) {
      if (budget <= 1024) result.reasoning_effort = 'low'
      else if (budget <= 8192) result.reasoning_effort = 'medium'
      else result.reasoning_effort = 'high'
    } else if (body.thinking.type === 'enabled') {
      result.reasoning_effort = 'high'
    }
  }

  return result
}

function convertMessage(msg: AnthropicMessage, output: OpenAIChatMessage[], model: string = ''): void {
  const content = msg.content

  // Simple string content
  if (typeof content === 'string') {
    output.push({ role: msg.role, content })
    return
  }

  // Array content blocks
  if (!Array.isArray(content) || content.length === 0) {
    output.push({ role: msg.role, content: '' })
    return
  }

  if (msg.role === 'user') {
    convertUserMessage(content, output)
  } else {
    convertAssistantMessage(content, output, model)
  }
}

function convertUserMessage(blocks: AnthropicContentBlock[], output: OpenAIChatMessage[]): void {
  // Separate tool_result blocks from other content
  const contentParts: OpenAIChatContentPart[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      contentParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const url = `data:${block.source.media_type};base64,${block.source.data}`
      contentParts.push({ type: 'image_url', image_url: { url } })
    } else if (block.type === 'tool_result') {
      // tool_result → separate tool message
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n')
          : ''
      output.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: resultContent,
      })
    }
  }

  if (contentParts.length > 0) {
    output.push({
      role: 'user',
      content: contentParts.length === 1 && contentParts[0].type === 'text'
        ? contentParts[0].text
        : contentParts,
    })
  }
}

function convertAssistantMessage(blocks: AnthropicContentBlock[], output: OpenAIChatMessage[], model: string = ''): void {
  let textContent = ''
  let reasoningContent = ''
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'thinking') {
      reasoningContent += block.thinking
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      })
    }
  }

  const msg: OpenAIChatMessage = {
    role: 'assistant',
    content: textContent || null,
  }

  // Only pass reasoning_content back for DeepSeek models to satisfy their mandatory back-transmission rule
  if (reasoningContent && model.toLowerCase().includes('deepseek')) {
    (msg as any).reasoning_content = reasoningContent
  }

  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls
  }

  output.push(msg)
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice
  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      return { type: 'function', function: { name: c.name } }
    }
  }
  return 'auto'
}
