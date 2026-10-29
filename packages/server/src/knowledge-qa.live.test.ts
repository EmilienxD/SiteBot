import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { validateConfig, type ResolvedConfig } from '@sitebot/config'
import { resolveModel, retrieve, type Citation, type StepInfo } from '@sitebot/core'
import { createNodeVectorStore } from '@sitebot/core/node'
import { createQueryEmbedder, runIngest } from '@sitebot/ingest'
import { createFetchHandler } from './fetch.js'
import { withNodeRuntime } from './node-runtime.js'

/**
 * Explicitly opt in to a small LOCAL inference batch. No provider mocks, SDK-only
 * shortcuts, paid defaults, model downloads, or writes to the deployment index.
 * See the docs-assistant recipe for the command and interpretation of failures.
 */
const enabled = process.env['SITEBOT_LIVE_QA'] === 'ollama'
const modelId = process.env['SITEBOT_LIVE_OLLAMA_MODEL']
const embeddingId = process.env['SITEBOT_LIVE_OLLAMA_EMBED_MODEL']
const origin = 'https://docs.example.com'

const documents = [
  {
    file: 'en-plans.html',
    lang: 'en',
    title: 'Plans',
    sections: [['Pro capacity', 'The Pro plan includes 12 workspaces. The trial lasts 7 days.']],
  },
  {
    file: 'fr-plans.html',
    lang: 'fr',
    title: 'Forfaits',
    sections: [
      [
        'Capacité Pro',
        'Le forfait Pro comprend 12 espaces de travail. La période d’essai dure 7 jours.',
      ],
    ],
  },
  {
    file: 'en-previews.html',
    lang: 'en',
    title: 'Draft previews',
    sections: [
      [
        'Enable draft previews',
        'Set publish.preview=true to create draft previews. Draft previews are private and are never indexed by search engines.',
      ],
      [
        'Preview expiration',
        'Draft previews expire after 72 hours. To renew a preview, create a new build; expiration cannot be extended.',
      ],
    ],
  },
  {
    file: 'fr-previews.html',
    lang: 'fr',
    title: 'Aperçus des brouillons',
    sections: [
      [
        'Activer les aperçus',
        'Définissez publish.preview=true pour créer des aperçus des brouillons. Ces aperçus sont privés et ne sont jamais indexés par les moteurs de recherche.',
      ],
      [
        'Expiration des aperçus',
        'Les aperçus des brouillons expirent après 72 heures. Pour renouveler un aperçu, créez une nouvelle compilation ; sa durée ne peut pas être prolongée.',
      ],
    ],
  },
  {
    file: 'en-recovery.html',
    lang: 'en',
    title: 'Recovery snapshots',
    sections: [
      [
        'Backup retention',
        'Recovery snapshots are retained for 21 days. Owners download a backup archive from Settings > Recovery. There is no French recovery guide.',
      ],
    ],
  },
]

interface Event {
  type: string
  [key: string]: unknown
}
const message = (text: string) => ({
  id: `m_${randomUUID()}`,
  role: 'user',
  parts: [{ type: 'text', text }],
})

async function removeFixture(directory: string): Promise<void> {
  // Verify the absolute target before recursive deletion on Windows.
  const cleanupPath = resolve(directory)
  if (
    dirname(cleanupPath) !== resolve(tmpdir()) ||
    !basename(cleanupPath).startsWith('sitebot-live-qa-')
  ) {
    throw new Error('Refusing to remove a path outside this run’s temporary directory.')
  }
  await rm(cleanupPath, { recursive: true, force: true })
}

describe.skipIf(!enabled)('live grounded documentation Q&A (Ollama)', () => {
  it('ingests real embeddings and exercises bilingual evidence through the server/tool loop', async () => {
    if (!modelId || !embeddingId)
      throw new Error(
        'Set both SITEBOT_LIVE_OLLAMA_MODEL and SITEBOT_LIVE_OLLAMA_EMBED_MODEL to already installed models.',
      )
    const generationUrl = process.env['SITEBOT_LIVE_OLLAMA_URL'] ?? 'http://127.0.0.1:11434/v1'
    const embeddingUrl = process.env['SITEBOT_LIVE_OLLAMA_EMBED_URL'] ?? 'http://127.0.0.1:11434'
    for (const endpoint of [generationUrl, embeddingUrl]) {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
        throw new Error('This zero-provider-cost live QA batch requires loopback Ollama endpoints.')
      }
    }
    const directory = await mkdtemp(join(tmpdir(), 'sitebot-live-qa-'))
    let handler: ReturnType<typeof createFetchHandler> | undefined
    let fallbackHandler: ReturnType<typeof createFetchHandler> | undefined
    const steps: StepInfo[] = []
    const offeredTools: string[][] = []
    try {
      for (const doc of documents) {
        await writeFile(
          join(directory, doc.file),
          `<html lang="${doc.lang}"><head><title>${doc.title}</title></head><body><main>${doc.sections.map(([heading, text]) => `<h2>${heading}</h2><p>${text}</p>`).join('')}</main></body></html>`,
        )
      }
      const validation = validateConfig(
        {
          version: 1,
          name: 'Example Docs',
          mode: 'chat',
          tools: [],
          storage: { type: 'memory' },
          backend: {
            provider: 'ollama',
            model: modelId,
            baseUrl: generationUrl,
            temperature: 0,
            maxOutputTokens: 240,
            maxRetries: 0,
            // Local inference has no provider fee. This is not a paid-model price.
            pricing: { [`ollama:${modelId}`]: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
          },
          prompt: {
            system:
              'Answer Example product questions using only the indexed public documentation. Always use search_knowledge_base before answering factual questions. Refine the search if evidence is incomplete. Cite supplied [n] numbers for factual claims. Never invent facts, config keys or citations. If the docs do not support the answer, say you do not know. Answer concisely, in at most three sentences.',
            includePageContext: false,
          },
          siteContext: {
            company: 'Example',
            description: 'Public documentation for a publishing tool.',
          },
          agent: {
            maxSteps: 4,
            toolChoice: 'required',
            stopWhen: { tokens: 12000, seconds: 180 },
            onMaxSteps: 'summarize',
          },
          security: {
            allowedOrigins: [origin],
            rateLimit: { perSession: '30/5m' },
            budget: { maxTokensPerSession: 40000, maxUsdPerDay: 1 },
          },
          knowledge: {
            sources: [{ type: 'files', id: 'public-docs', glob: '*.html', baseUrl: origin }],
            embedding: {
              provider: 'ollama',
              model: embeddingId,
              baseUrl: embeddingUrl,
              documentPrefix: process.env['SITEBOT_LIVE_EMBED_DOCUMENT_PREFIX'],
              queryPrefix: process.env['SITEBOT_LIVE_EMBED_QUERY_PREFIX'],
            },
            store: { type: 'sqlite', path: join(directory, 'index.db') },
            chunk: { strategy: 'heading', minTokens: 0, maxTokens: 180 },
            extract: { minChars: 0 },
            retrieval: {
              mode: 'tool',
              topK: 3,
              minScore: 0.35,
              maxContextTokens: 700,
              expandNeighbours: 1,
              dedupeByUrl: false,
              includeCitations: true,
            },
          },
          ui: { locale: 'en', supportedLocales: ['en', 'fr'] },
          telemetry: { logLevel: 'silent' },
          hooks: {
            onStep: (step: StepInfo) => {
              steps.push(step)
            },
          },
        },
        { env: {}, baseDir: directory },
      )
      if (!validation.ok) throw new Error(JSON.stringify(validation.errors))
      const config = validation.value
      const ingested = await runIngest(config, { baseDir: directory, manifestDir: directory })
      console.warn(
        'LIVE QA ingestion',
        JSON.stringify({ model: modelId, embeddingModel: embeddingId, ...ingested }),
      )
      expect(ingested.index.documents).toBe(5)
      expect(ingested.index.chunks).toBe(7)
      expect(Number.isFinite(ingested.embedding.tokens)).toBe(true)
      expect(ingested.embedding.estimatedUsd).toBe(0)
      const rerun = await runIngest(config, { baseDir: directory, manifestDir: directory })
      expect(rerun.embedding.chunks).toBe(0)

      const store = await createNodeVectorStore(config.knowledge.store, { baseDir: directory })
      try {
        const embedder = await createQueryEmbedder(config.knowledge.embedding!)
        for (const [locale, query, expected] of [
          [
            'en',
            'How many separate areas can a paying Pro team organize its work into?',
            'en-plans.html',
          ],
          [
            'fr',
            'Combien de zones distinctes une équipe Pro peut-elle utiliser pour travailler ?',
            'fr-plans.html',
          ],
          [
            'fr',
            'Pendant combien de jours les sauvegardes de récupération sont-elles conservées ?',
            'en-recovery.html',
          ],
        ]) {
          const result = await retrieve({ store, embedder }, query!, config, locale)
          console.warn('LIVE QA retrieval', JSON.stringify({ locale, query, hits: result.hits }))
          expect.soft(result.hits[0]?.url, query).toBe(`${origin}/${expected}`)
          expect.soft(Number.isFinite(result.tokensEmbedded)).toBe(true)
        }
        const adjacent = await retrieve(
          { store, embedder },
          'How do I enable private draft previews?',
          config,
          'en',
        )
        console.warn('LIVE QA adjacent evidence', JSON.stringify(adjacent))
        expect
          .soft(adjacent.hits.map((hit) => hit.text).join('\n'))
          .toContain('publish.preview=true')
        expect.soft(adjacent.hits.map((hit) => hit.text).join('\n')).toContain('72 hours')
      } finally {
        await store.close()
      }

      const startHandler = (deployment: ResolvedConfig) =>
        createFetchHandler(
          deployment,
          withNodeRuntime(deployment, {
            deps: {
              adapters: {
                ollama: async (entry) => {
                  const actual = (await resolveModel(entry)).model as LanguageModelV3
                  // Observe the actual adapter inputs, forwarding every call to Ollama.
                  return new Proxy(actual, {
                    get(target, property, receiver) {
                      if (property === 'doStream')
                        return (options: Parameters<LanguageModelV3['doStream']>[0]) => {
                          offeredTools.push((options.tools ?? []).map((tool) => tool.name))
                          console.warn(
                            'LIVE QA model call',
                            JSON.stringify({
                              tools: offeredTools.at(-1),
                              toolChoice: options.toolChoice,
                              promptCharacters: JSON.stringify(options.prompt).length,
                            }),
                          )
                          return target.doStream(options)
                        }
                      return Reflect.get(target, property, receiver)
                    },
                  })
                },
              },
            },
          }),
        )

      handler = startHandler(config)
      const send = async (
        label: string,
        locale: string,
        question: string,
        sessionId = `s_${randomUUID()}`,
        activeHandler = handler!,
      ) => {
        const start = steps.length
        const response = await activeHandler(
          new Request(`${origin}/api/chat`, {
            method: 'POST',
            signal: AbortSignal.timeout(180000),
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, locale, messages: [message(question)] }),
          }),
        )
        expect(response.status).toBe(200)
        const events = (await response.text())
          .split('\n')
          .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
          .map((line) => JSON.parse(line.slice(6)) as Event)
        const text = events
          .filter((event) => event.type === 'text-delta')
          .map((event) => event['delta'])
          .join('')
        const citations = events
          .filter((event) => event.type === 'data-citations')
          .flatMap((event) => (event['data'] as { items: Citation[] }).items)
        const searches = events
          .filter((event) => event.type === 'tool-output-available')
          .map((event) => event['output'])
        console.warn(
          'LIVE QA answer',
          JSON.stringify({
            label,
            locale,
            question,
            text,
            citations,
            searches,
            steps: steps.slice(start),
          }),
        )
        expect
          .soft(
            events.filter((event) => event.type === 'error' || event.type === 'data-error'),
            label,
          )
          .toEqual([])
        expect.soft(searches.length, label).toBeGreaterThan(0)
        expect.soft(text.length, label).toBeGreaterThan(15)
        expect.soft(steps.length - start, label).toBeLessThanOrEqual(4)
        expect.soft(text, label).not.toMatch(/[\u0e00-\u0e7f]/)
        expect
          .soft(
            events.some((event) => /client-tool|approval-request|navigate/.test(event.type)),
            label,
          )
          .toBe(false)
        const cited = [...text.matchAll(/\[(\d+)\]/g)].map((match) => `c${match[1]}`)
        expect
          .soft(
            cited.every((id) => citations.some((citation) => citation.id === id)),
            label,
          )
          .toBe(true)
        return { text, citations, searches, cited }
      }
      const session = `s_${randomUUID()}`
      const en = await send(
        'English paraphrase',
        'en',
        'How many separate areas can a Pro team organize its work into?',
        session,
      )
      expect.soft(en.text).toMatch(/12|twelve/i)
      expect.soft(en.text).toMatch(/workspaces|spaces|areas/i)
      expect
        .soft(en.citations.some((c) => c.url === `${origin}/en-plans.html` && c.lang === 'en'))
        .toBe(true)
      expect.soft(en.cited.length).toBeGreaterThan(0)
      const followup = await send(
        'French follow-up in the same session',
        'fr',
        'Et combien de jours dure la période d’essai de ce forfait ?',
        session,
      )
      expect.soft(followup.text).toMatch(/7|sept/i)
      expect.soft(followup.text).toMatch(/essai|jours/i)
      expect
        .soft(
          followup.citations.some((c) => c.url === `${origin}/fr-plans.html` && c.lang === 'fr'),
        )
        .toBe(true)
      const fr = await send(
        'French paraphrase',
        'fr',
        'Combien d’espaces de travail le forfait Pro comprend-il ?',
      )
      expect.soft(fr.text).toMatch(/12|douze/i)
      expect.soft(fr.text).toMatch(/espaces|forfait/i)
      expect.soft(fr.citations.some((c) => c.lang === 'fr')).toBe(true)
      const preview = await send(
        'Neighboring evidence',
        'en',
        'Which configuration switch creates private draft previews, when do they expire, and how can I renew one?',
      )
      expect.soft(preview.text).toContain('publish.preview')
      expect.soft(preview.text).toMatch(/72|seventy-two/i)
      expect.soft(preview.text).toMatch(/new build/i)
      expect.soft(JSON.stringify(preview.searches)).toContain('publish.preview=true')
      expect.soft(JSON.stringify(preview.searches)).toContain('72 hours')
      const absent = await send(
        'Unsupported question',
        'en',
        'What is the documented maximum payload size in gigabytes for satellite telemetry uploads?',
      )
      expect
        .soft(absent.text)
        .toMatch(/not|no |cannot|can't|don't|doesn.t|unavailable|missing|unknown/i)
      expect.soft(absent.text).not.toMatch(/\b\d+\s*(GB|gigabytes)\b/i)
      const fallback = await send(
        'French answer from English-only evidence',
        'fr',
        'Pendant combien de jours les sauvegardes de récupération sont-elles conservées ?',
      )
      expect.soft(fallback.text).toMatch(/21|vingt.et.un/i)
      expect.soft(fallback.text).toMatch(/jours|sauvegardes/i)
      expect
        .soft(
          fallback.citations.some((c) => c.url === `${origin}/en-recovery.html` && c.lang === 'en'),
        )
        .toBe(true)
      expect.soft(fallback.cited.length).toBeGreaterThan(0)
      // Separate mixed-corpus relevance failures from fallback mechanics when
      // the corpus contains no matching-language pages at all.
      const fallbackDirectory = join(directory, 'fallback')
      await mkdir(fallbackDirectory)
      const englishOnly: ResolvedConfig = {
        ...config,
        knowledge: {
          ...config.knowledge,
          sources: [{ type: 'files', id: 'english-docs', glob: 'en-*.html', baseUrl: origin }],
          store: { type: 'sqlite', path: join(fallbackDirectory, 'index.db') },
        },
      }
      await runIngest(englishOnly, { baseDir: directory, manifestDir: fallbackDirectory })
      const englishStore = await createNodeVectorStore(englishOnly.knowledge.store, {
        baseDir: directory,
      })
      try {
        const embedder = await createQueryEmbedder(englishOnly.knowledge.embedding!)
        const result = await retrieve(
          { store: englishStore, embedder },
          'Pendant combien de jours les sauvegardes de récupération sont-elles conservées ?',
          englishOnly,
          'fr',
        )
        console.warn('LIVE QA English-only retrieval', JSON.stringify(result))
        expect.soft(result.hits[0]?.url).toBe(`${origin}/en-recovery.html`)
        expect.soft(result.hits.every((hit) => hit.lang === 'en')).toBe(true)
      } finally {
        await englishStore.close()
      }
      fallbackHandler = startHandler(englishOnly)
      const onlyEnglish = await send(
        'French question in an English-only corpus',
        'fr',
        'Pendant combien de jours les sauvegardes de récupération sont-elles conservées ?',
        `s_${randomUUID()}`,
        fallbackHandler,
      )
      expect.soft(onlyEnglish.text).toMatch(/21|vingt.et.un/i)
      expect.soft(onlyEnglish.text).toMatch(/jours|sauvegardes/i)
      expect
        .soft(
          onlyEnglish.citations.some(
            (c) => c.url === `${origin}/en-recovery.html` && c.lang === 'en',
          ),
        )
        .toBe(true)
      expect.soft(onlyEnglish.cited.length).toBeGreaterThan(0)
      expect(offeredTools.length).toBeGreaterThan(0)
      expect(
        offeredTools.every((tools) => tools.every((name) => name === 'search_knowledge_base')),
      ).toBe(true)
      expect(steps.reduce((sum, step) => sum + step.usage.inputTokens, 0)).toBeGreaterThan(0)
      expect(steps.reduce((sum, step) => sum + step.usage.outputTokens, 0)).toBeGreaterThan(0)
      console.warn(
        'LIVE QA usage',
        JSON.stringify({
          offeredTools,
          steps: steps.length,
          inputTokens: steps.reduce((sum, step) => sum + step.usage.inputTokens, 0),
          outputTokens: steps.reduce((sum, step) => sum + step.usage.outputTokens, 0),
          providerCostUsd: 0,
        }),
      )
    } finally {
      try {
        await Promise.all([handler?.dispose(), fallbackHandler?.dispose()])
      } finally {
        await removeFixture(directory)
      }
    }
  }, 1_200_000)
})
