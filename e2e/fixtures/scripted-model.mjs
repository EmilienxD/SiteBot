// A `provider: custom` model for the browser tests: deterministic, offline,
// and scripted by keywords in the visitor's last message. It speaks the
// LanguageModelV3 stream protocol directly, so it needs no SDK import.
//
//   "call <tool> {json}" → that tool call, verbatim (used by the example smoke tests)
//   "highlight #id"   → highlight_section tool call
//   "fill"            → fill_wholesale_form (approval-gated client tool)
//   "fill bad"        → same, with a volume that is not an option
//   "go to shop"      → navigate to /shop
//   "forms?"          → echo the form outline from the page context
//   "slow"            → a long answer streamed in small, delayed chunks
//   anything else     → a short markdown answer
// After a tool result, it reports that result back verbatim.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
}

export function createModel(entry) {
  let calls = 0
  return {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: entry.model,
    supportedUrls: {},
    async doGenerate() {
      throw new Error('scripted model: doGenerate is not used by the engine')
    },
    async doStream(options) {
      calls += 1
      const { parts, delayMs } = script(options.prompt, calls)
      return { stream: toStream(parts, delayMs) }
    },
  }
}

function script(prompt, call) {
  const last = prompt.at(-1)
  if (last?.role === 'tool') return reply(describeToolResult(last.content))

  const raw = lastUserText(prompt)
  const direct = /^call (\w+)\s*(\{.*\})?$/s.exec(raw.trim())
  if (direct) return toolCall(direct[1], JSON.parse(direct[2] ?? '{}'), call)

  const text = raw.toLowerCase()
  if (text.includes('highlight')) {
    const selector = /#[\w-]+/.exec(text)?.[0] ?? '#subscriptions'
    return toolCall('highlight_section', { selector }, call)
  }
  if (text.includes('fill bad'))
    return toolCall(
      'fill_wholesale_form',
      {
        selector: '#wholesale-form',
        fields: { business: 'Bean Cafe', email: 'owner@beancafe.com', volume: '30 kg' },
      },
      call,
    )
  if (text.includes('fill'))
    return toolCall(
      'fill_wholesale_form',
      {
        selector: '#wholesale-form',
        fields: { business: 'Bean Cafe', email: 'owner@beancafe.com', volume: '5–20 kg' },
      },
      call,
    )
  if (text.includes('go to shop')) return toolCall('navigate', { path: '/shop' }, call)
  if (text.includes('forms?')) {
    // Wherever the engine placed the page context, the outline is in the prompt.
    const all = prompt
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text ?? '').join('\n'),
      )
      .join('\n')
    return reply(/\[Form [^\]]*\]/.exec(all)?.[0] ?? 'No forms on this page.')
  }
  if (text.includes('slow'))
    return {
      parts: textParts(Array.from({ length: 40 }, (_, index) => `Word${index + 1} `)),
      delayMs: 60,
    }
  return reply(`**Hello** from the scripted model. You said: ${lastUserText(prompt)}`)
}

function describeToolResult(content) {
  const result = content.find((part) => part.type === 'tool-result')
  const output = result?.output
  if (output?.type === 'execution-denied') return 'No problem — I left the page as it is.'
  const value = output && 'value' in output ? output.value : output
  return `Tool ${result?.toolName} returned: ${JSON.stringify(value)}`
}

function lastUserText(prompt) {
  const user = prompt.findLast((message) => message.role === 'user')
  if (!user) return ''
  return typeof user.content === 'string'
    ? user.content
    : user.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
}

function reply(text) {
  return { parts: textParts([text]), delayMs: 0 }
}

function textParts(chunks) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...chunks.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ]
}

function toolCall(toolName, input, call) {
  return {
    parts: [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `tc_${call}`, toolName, input: JSON.stringify(input) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
    ],
    delayMs: 0,
  }
}

function toStream(parts, delayMs) {
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      if (index >= parts.length) return controller.close()
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      controller.enqueue(parts[index])
      index += 1
    },
  })
}
