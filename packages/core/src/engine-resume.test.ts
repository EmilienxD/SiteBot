import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { readSse, testConfig, testContext, userMessage } from '../test/helpers.js'
import { createEngine } from './engine.js'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

/**
 * docs/03 §5 — an approval-gated *client* tool crosses the wire twice: the
 * approval resume hands the call to the page, and the page's result resumes
 * the model. The first resume used to run the model against a tool it could
 * not execute, which ended the turn silently with the form never filled.
 */

const SESSION = 's_01J9X8Y7Z6ABCDEFGHJKMNPQRS'
const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

function model(): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call += 1
      const chunks: LanguageModelV3StreamPart[] =
        call === 1
          ? [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'tc1',
                toolName: 'fill_wholesale_form',
                input: JSON.stringify({ selector: '#form', fields: { business: 'Tidewater' } }),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
            ]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'The form is filled in.' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
            ]
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }),
      }
    },
  })
}

const events = async (response: Response) =>
  (await readSse(response))
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })

describe('resume of an approved client tool', () => {
  it('hands the call to the page, then resumes the model with its result', async () => {
    const mock = model()
    const engine = createEngine(
      testConfig({
        mode: 'agent',
        tools: [
          {
            name: 'fill_wholesale_form',
            description: 'Fill the wholesale inquiry form on the page.',
            parameters: { type: 'object', properties: {}, additionalProperties: true },
            executor: { type: 'client', id: 'fill_form' },
            requiresApproval: true,
          },
        ],
      }),
      { adapters: { anthropic: async () => mock } },
    )

    const first = await events(
      await engine.handleChat(
        { sessionId: SESSION, messages: [userMessage('Fill the wholesale form')] },
        testContext(),
      ),
    )
    const request = first.find((event) => event.type === 'data-approval-request')?.data
    expect(request).toBeDefined()
    // Gated: no client call goes out before the user answers.
    expect(first.some((event) => event.type === 'data-client-tool-call')).toBe(false)
    const runId = String(request!.runId)

    const approved = await events(
      await engine.handleChat(
        {
          sessionId: SESSION,
          messages: [],
          trigger: 'resume',
          resume: {
            runId,
            approvals: [{ approvalId: String(request!.approvalId), decision: 'approve' }],
          },
        },
        testContext(),
      ),
    )
    const handoff = approved.find((event) => event.type === 'data-client-tool-call')?.data
    expect(handoff).toMatchObject({
      runId,
      toolCallId: 'tc1',
      toolName: 'fill_wholesale_form',
      input: { selector: '#form', fields: { business: 'Tidewater' } },
    })
    expect(mock.doStreamCalls).toHaveLength(1)

    const finished = await events(
      await engine.handleChat(
        {
          sessionId: SESSION,
          messages: [],
          trigger: 'resume',
          resume: { runId, clientToolResults: [{ toolCallId: 'tc1', output: { filled: 1 } }] },
        },
        testContext(),
      ),
    )
    expect(mock.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(mock.doStreamCalls[1]?.prompt)).toContain('"filled":1')
    expect(finished.some((event) => event.type === 'text-delta')).toBe(true)
  })
})
