/**
 * Provider Service — preset-based provider configuration
 *
 * Storage: ~/.claude/bingo/providers.json (lightweight index)
 * Active provider env vars written to ~/.claude/bingo/settings.json
 * (isolated from the original Claude Code's ~/.claude/settings.json)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { getDirectFetchOptions } from '../../utils/proxy.ts'
import { ApiError } from '../middleware/errorHandler.js'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import type { AnthropicRequest, AnthropicResponse } from '../proxy/transform/types.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import type {
  SavedProvider,
  ProvidersIndex,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderInput,
  ProviderTestResult,
  ProviderTestStepResult,
  ApiFormat,
  SlotName,
  SlotEntry,
  SlotTable,
} from '../types/provider.ts'
import { SlotTableSchema } from '../types/provider.ts'

const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const

const DEFAULT_INDEX: ProvidersIndex = { activeId: null, providers: [] }

export class ProviderService {
  private static serverPort = 3456

  static setServerPort(port: number): void {
    ProviderService.serverPort = port
  }

  static getServerPort(): number {
    return ProviderService.serverPort
  }
  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getCcHahaDir(): string {
    return path.join(this.getConfigDir(), 'bingo')
  }

  private getIndexPath(): string {
    return path.join(this.getCcHahaDir(), 'providers.json')
  }

  private getSettingsPath(): string {
    return path.join(this.getCcHahaDir(), 'settings.json')
  }

  private getSlotsPath(): string {
    return path.join(this.getCcHahaDir(), 'slots.json')
  }

  private async readIndex(): Promise<ProvidersIndex> {
    try {
      const raw = await fs.readFile(this.getIndexPath(), 'utf-8')
      return JSON.parse(raw) as ProvidersIndex
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_INDEX, providers: [] }
      }
      throw ApiError.internal(`Failed to read providers index: ${err}`)
    }
  }

  private async writeIndex(index: ProvidersIndex): Promise<void> {
    const filePath = this.getIndexPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    const tmpFile = `${filePath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(index, null, 2) + '\n', 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write providers index: ${err}`)
    }
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.getSettingsPath(), 'utf-8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw ApiError.internal(`Failed to read settings.json: ${err}`)
    }
  }

  private async writeSettings(settings: Record<string, unknown>): Promise<void> {
    const filePath = this.getSettingsPath()
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    const tmpFile = `${filePath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmpFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
      await fs.rename(tmpFile, filePath)
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {})
      throw ApiError.internal(`Failed to write settings.json: ${err}`)
    }
  }

  // --- CRUD ---

  async listProviders(): Promise<{ providers: SavedProvider[]; activeId: string | null }> {
    const index = await this.readIndex()
    return { providers: index.providers, activeId: index.activeId }
  }

  async getProvider(id: string): Promise<SavedProvider> {
    const index = await this.readIndex()
    const provider = index.providers.find((p) => p.id === id)
    if (!provider) throw ApiError.notFound(`Provider not found: ${id}`)
    return provider
  }

  async addProvider(input: CreateProviderInput): Promise<SavedProvider> {
    const index = await this.readIndex()

    const provider: SavedProvider = {
      id: crypto.randomUUID(),
      presetId: input.presetId,
      name: input.name,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      apiFormat: input.apiFormat ?? 'anthropic',
      models: input.models,
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.extra !== undefined && { extra: input.extra }),
    }

    index.providers.push(provider)
    await this.writeIndex(index)
    return provider
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<SavedProvider> {
    const index = await this.readIndex()
    const idx = index.providers.findIndex((p) => p.id === id)
    if (idx === -1) throw ApiError.notFound(`Provider not found: ${id}`)

    const existing = index.providers[idx]
    const updated: SavedProvider = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
      ...(input.apiFormat !== undefined && { apiFormat: input.apiFormat }),
      ...(input.models !== undefined && { models: input.models }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.extra !== undefined && { extra: input.extra }),
    }

    index.providers[idx] = updated
    await this.writeIndex(index)

    if (index.activeId === id) {
      await this.syncToSettings(updated)
    }

    return updated
  }

  async deleteProvider(id: string): Promise<void> {
    const index = await this.readIndex()
    const idx = index.providers.findIndex((p) => p.id === id)
    if (idx === -1) throw ApiError.notFound(`Provider not found: ${id}`)

    if (index.activeId === id) {
      throw ApiError.conflict('Cannot delete the active provider. Switch to another provider first.')
    }

    index.providers.splice(idx, 1)
    await this.writeIndex(index)
  }

  // --- Activation ---

  async activateProvider(id: string): Promise<void> {
    const index = await this.readIndex()
    const provider = index.providers.find((p) => p.id === id)
    if (!provider) throw ApiError.notFound(`Provider not found: ${id}`)

    index.activeId = id
    await this.writeIndex(index)

    if (provider.presetId === 'official') {
      await this.clearProviderFromSettings()
    } else {
      await this.syncToSettings(provider)
    }
  }

  async activateOfficial(): Promise<void> {
    const index = await this.readIndex()
    index.activeId = null
    await this.writeIndex(index)
    await this.clearProviderFromSettings()
  }

  // --- Settings sync ---

  private async syncToSettings(provider: SavedProvider): Promise<void> {
    const settings = await this.readSettings()
    const existingEnv = (settings.env as Record<string, string>) || {}

    const needsProxy = provider.apiFormat != null && provider.apiFormat !== 'anthropic'
    const baseUrl = needsProxy
      ? `http://127.0.0.1:${ProviderService.serverPort}/proxy`
      : provider.baseUrl

    settings.env = {
      ...existingEnv,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: needsProxy ? 'proxy-managed' : provider.apiKey,
      ANTHROPIC_MODEL: provider.models.main,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.models.haiku,
      ANTHROPIC_DEFAULT_SONNET_MODEL: provider.models.sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: provider.models.opus,
    }

    await this.writeSettings(settings)
  }

  private async clearProviderFromSettings(): Promise<void> {
    const settings = await this.readSettings()
    const env = (settings.env as Record<string, string>) || {}

    for (const key of MANAGED_ENV_KEYS) {
      delete env[key]
    }

    settings.env = env
    if (Object.keys(env).length === 0) {
      delete settings.env
    }

    await this.writeSettings(settings)
  }

  /**
   * Sync settings.json based on the current slot table.
   *
   * Examines all configured slots to determine whether the CLI should connect
   * through the local proxy or directly. If ANY slot uses a non-anthropic format
   * (openai_chat, openai_responses), the proxy is required and settings.json is
   * written with:
   *   - ANTHROPIC_BASE_URL → http://127.0.0.1:{port}/proxy
   *   - ANTHROPIC_AUTH_TOKEN → "proxy-managed"
   *
   * Model env vars (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL) are populated
   * from the slot table so the CLI requests the correct model names, which the
   * proxy's identifySlot() then routes to the right provider.
   *
   * If ALL configured slots use native anthropic format, we write the main
   * slot's provider info directly (no proxy needed).
   *
   * If no slots are configured at all, settings.json is left unchanged.
   */
  private async syncSettingsForSlots(slots: SlotTable): Promise<void> {
    const index = await this.readIndex()

    // Collect resolved slot info
    type ResolvedSlot = { slot: SlotName; provider: SavedProvider; modelId: string; label?: string | null }
    const resolved: ResolvedSlot[] = []
    for (const slotName of ['main', 'haiku', 'sonnet', 'opus'] as const) {
      const entry = slots[slotName]
      if (!entry) continue
      const provider = index.providers.find((p) => p.id === entry.providerId)
      if (!provider) continue
      resolved.push({ slot: slotName, provider, modelId: entry.modelId, label: entry.label })
    }

    // No slots configured at all — don't touch settings.json
    if (resolved.length === 0) return

    const needsProxy = resolved.some(
      (r) => r.provider.apiFormat != null && r.provider.apiFormat !== 'anthropic',
    )

    const settings = await this.readSettings()
    const existingEnv = (settings.env as Record<string, string>) || {}

    // Build model env vars from slot table.
    //
    // The proxy's identifySlot() routes requests by looking for keywords
    // (haiku/sonnet/opus) in the model name the CLI sends. If the actual
    // model ID (e.g., "deepseek-chat") doesn't contain the keyword, the
    // proxy would misroute to "main". To fix this, we ensure the env var
    // value always contains the slot keyword so identifySlot() can match.
    const modelEnv: Record<string, string> = {}
    for (const r of resolved) {
      const rawName = r.label || r.modelId
      switch (r.slot) {
        case 'main':
          modelEnv.ANTHROPIC_MODEL = rawName
          break
        case 'haiku': {
          // Ensure the value contains "haiku" for identifySlot() routing
          const name = /haiku/i.test(rawName) ? rawName : `${rawName}-haiku`
          modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = name
          break
        }
        case 'sonnet': {
          const name = /sonnet/i.test(rawName) ? rawName : `${rawName}-sonnet`
          modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = name
          break
        }
        case 'opus': {
          const name = /opus/i.test(rawName) ? rawName : `${rawName}-opus`
          modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = name
          break
        }
      }
    }

    if (needsProxy) {
      settings.env = {
        ...existingEnv,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${ProviderService.serverPort}/proxy`,
        ANTHROPIC_AUTH_TOKEN: 'proxy-managed',
        ...modelEnv,
      }
    } else {
      // All slots are native anthropic — use main slot's provider directly
      const mainSlot = resolved.find((r) => r.slot === 'main') || resolved[0]
      settings.env = {
        ...existingEnv,
        ANTHROPIC_BASE_URL: mainSlot.provider.baseUrl,
        ANTHROPIC_AUTH_TOKEN: mainSlot.provider.apiKey,
        ...modelEnv,
      }
    }

    await this.writeSettings(settings)
  }

  // --- Auth status ---

  /**
   * Check whether any usable auth exists:
   *  1. A bingo provider is active → has auth
   *  2. Original ~/.claude/settings.json has ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY → has auth
   *  3. process.env already has ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN → has auth
   *  4. None of the above → needs setup
   */
  async checkAuthStatus(): Promise<{
    hasAuth: boolean
    source: 'bingo-provider' | 'original-settings' | 'env' | 'none'
    activeProvider?: string
  }> {
    // 1. Check bingo active provider
    const index = await this.readIndex()
    if (index.activeId) {
      const provider = index.providers.find(p => p.id === index.activeId)
      if (provider?.apiKey) {
        return { hasAuth: true, source: 'bingo-provider', activeProvider: provider.name }
      }
    }

    // 2. Check process.env (covers .env file + inherited env)
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      return { hasAuth: true, source: 'env' }
    }

    // 3. Check original ~/.claude/settings.json
    try {
      const originalPath = path.join(this.getConfigDir(), 'settings.json')
      const raw = await fs.readFile(originalPath, 'utf-8')
      const settings = JSON.parse(raw) as { env?: Record<string, string> }
      const env = settings.env ?? {}
      if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) {
        return { hasAuth: true, source: 'original-settings' }
      }
    } catch {
      // File doesn't exist or invalid
    }

    return { hasAuth: false, source: 'none' }
  }

  // --- Proxy support ---

  async getActiveProviderForProxy(): Promise<{
    baseUrl: string
    apiKey: string
    apiFormat: ApiFormat
  } | null> {
    const index = await this.readIndex()
    if (!index.activeId) return null
    const provider = index.providers.find((p) => p.id === index.activeId)
    if (!provider) return null
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat ?? 'anthropic',
    }
  }

  // --- Slot routing ---

  async readSlots(): Promise<SlotTable> {
    try {
      const raw = await fs.readFile(this.getSlotsPath(), 'utf-8')
      return SlotTableSchema.parse(JSON.parse(raw))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return SlotTableSchema.parse({})
      }
      throw ApiError.internal(`Failed to read slots: ${err}`)
    }
  }

  async writeSlots(slots: SlotTable): Promise<void> {
    const filePath = this.getSlotsPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmp, JSON.stringify(slots, null, 2) + '\n', 'utf-8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      await fs.unlink(tmp).catch(() => {})
      throw ApiError.internal(`Failed to write slots: ${err}`)
    }
  }

  async setSlot(slot: SlotName, entry: SlotEntry): Promise<SlotTable> {
    const slots = await this.readSlots()
    slots[slot] = entry
    await this.writeSlots(slots)

    // Auto-sync settings.json so the CLI knows where to connect.
    // When any slot uses a non-anthropic provider, the CLI must go through
    // the local proxy; when all slots are anthropic (or empty), we can
    // write direct provider info instead.
    await this.syncSettingsForSlots(slots)

    return slots
  }

  async getProviderForSlot(slotName: SlotName): Promise<{
    baseUrl: string
    apiKey: string
    apiFormat: ApiFormat
    modelId: string
    label?: string | null
  } | null> {
    const slots = await this.readSlots()
    const entry = slots[slotName]
    if (!entry) return null
    const index = await this.readIndex()
    const provider = index.providers.find((p) => p.id === entry.providerId)
    if (!provider) return null
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat ?? 'anthropic',
      modelId: entry.modelId,
      label: entry.label,
    }
  }

  async fetchProviderModels(id: string): Promise<string[]> {
    const provider = await this.getProvider(id)
    const preset = PROVIDER_PRESETS.find(p => p.id === provider.presetId)

    const base = provider.baseUrl.replace(/\/+$/, '')
    if (!base && provider.presetId !== 'official') return []

    // Special case for Official
    if (provider.presetId === 'official') {
      return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307']
    }

    const modelsUrl = preset?.modelsUrl || '/v1/models'
    // modelsUrl 为绝对 URL 时直接使用（如 DeepSeek: baseUrl 是 anthropic 端，模型列表需走 OpenAI 端）
    const url = modelsUrl.startsWith('http') ? modelsUrl : `${base}${modelsUrl}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const authStyle = preset?.modelsAuthStyle || (provider.apiFormat === 'anthropic' ? 'x-api-key' : 'bearer')
    if (authStyle === 'x-api-key') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    }

    try {
      const directOpts = getDirectFetchOptions()
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000), ...directOpts })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        console.error(`[ProviderService] Failed to fetch models from ${url}: ${res.status} ${errText}`)
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }
      const data = await res.json() as any
      const dataPath = preset?.modelsDataPath || 'data'
      const list = data[dataPath] ?? data.data ?? data.models ?? []
      if (!Array.isArray(list)) return []
      return list.map((m: any) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
    } catch (err) {
      console.error(`[ProviderService] Error fetching models from ${url}:`, err)
      throw err
    }
  }

  // --- Test ---

  async testProvider(
    id: string,
    overrides?: { baseUrl?: string; modelId?: string; apiFormat?: ApiFormat },
  ): Promise<ProviderTestResult> {
    const provider = await this.getProvider(id)
    const baseUrl = overrides?.baseUrl || provider.baseUrl
    const apiFormat = overrides?.apiFormat ?? provider.apiFormat ?? 'anthropic'

    // If no modelId provided, try to fetch from provider or use preset default
    let modelId = overrides?.modelId || provider.models.main
    const needsAutoDetect =
      !modelId ||
      modelId === 'auto' ||
      (apiFormat !== 'anthropic' && modelId.startsWith('claude-'))
    if (needsAutoDetect) {
      const fetched = await this.fetchProviderModels(id).catch(() => [])
      if (fetched.length > 0) {
        modelId = fetched[0] // Use first available model for testing
      }
    }

    // 兜底：动态拉取失败时，按 apiFormat 使用通用 fallback 模型做连通性测试
    if (!modelId) {
      if (apiFormat === 'anthropic') {
        modelId = 'claude-3-5-haiku-20241022'
      } else {
        // openai_chat / openai_responses: 无法确定模型，返回有意义的错误
        return {
          connectivity: {
            success: false,
            latencyMs: 0,
            error: '无法确定测试用模型：models.main 为空且自动拉取模型列表失败。请先在槽位配置中选择模型，或检查 API Key 和网络连接。',
          },
        }
      }
    }

    if (!baseUrl || !provider.apiKey) {
      return { connectivity: { success: false, latencyMs: 0, error: 'Missing baseUrl or apiKey' } }
    }
    return this.testProviderConfig({
      baseUrl,
      apiKey: provider.apiKey,
      modelId,
      apiFormat,
    })
  }

  async testProviderConfig(input: TestProviderInput): Promise<ProviderTestResult> {
    const format: ApiFormat = input.apiFormat ?? 'anthropic'
    const base = input.baseUrl.replace(/\/+$/, '')

    // ── Step 1: Basic connectivity ───────────────────────────
    // Directly call the upstream API to verify URL, key, and model.
    const step1 = await this.testConnectivity(base, input.apiKey, input.modelId, format)

    // If connectivity failed, no point running step 2
    if (!step1.success) {
      return { connectivity: step1 }
    }

    // For native Anthropic format, no proxy pipeline to test
    if (format === 'anthropic') {
      return { connectivity: step1 }
    }

    // ── Step 2: Full proxy pipeline ──────────────────────────
    // Anthropic request → transform → upstream → transform back → validate
    const step2 = await this.testProxyPipeline(base, input.apiKey, input.modelId, format)

    return { connectivity: step1, proxy: step2 }
  }

  /** Step 1: Direct upstream call to verify connectivity, auth, and model. */
  private async testConnectivity(
    base: string,
    apiKey: string,
    modelId: string,
    format: ApiFormat,
  ): Promise<ProviderTestStepResult> {
    const start = Date.now()
    try {
      const { url, headers, body } = buildDirectTestRequest(base, apiKey, modelId, format)
      const directOpts = getDirectFetchOptions()
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        ...directOpts,
      })

      const latencyMs = Date.now() - start
      const resBody = await response.json().catch(() => null) as Record<string, unknown> | null

      if (!response.ok) {
        let error = `HTTP ${response.status}`
        if (resBody?.error && typeof resBody.error === 'object') {
          error = ((resBody.error as Record<string, unknown>).message as string) || error
        }
        return { success: false, latencyMs, error, modelUsed: modelId, httpStatus: response.status }
      }

      // Validate response structure
      const valid = validateResponseBody(resBody, format)
      if (!valid.ok) {
        return { success: false, latencyMs, error: valid.error, modelUsed: modelId, httpStatus: response.status }
      }

      return { success: true, latencyMs, modelUsed: valid.model || modelId, httpStatus: response.status }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { success: false, latencyMs, error: 'Request timed out (30s)', modelUsed: modelId }
      }
      return { success: false, latencyMs, error: err instanceof Error ? err.message : String(err), modelUsed: modelId }
    }
  }

  /** Step 2: Full proxy pipeline — Anthropic → transform → upstream → transform back → validate. */
  private async testProxyPipeline(
    base: string,
    apiKey: string,
    modelId: string,
    format: 'openai_chat' | 'openai_responses',
  ): Promise<ProviderTestStepResult> {
    const start = Date.now()
    try {
      // Build an Anthropic Messages API request (same shape as what CLI sends)
      const anthropicReq: AnthropicRequest = {
        model: modelId,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      }

      // Transform to OpenAI format
      let upstreamUrl: string
      let transformedBody: unknown
      if (format === 'openai_chat') {
        transformedBody = anthropicToOpenaiChat(anthropicReq)
        upstreamUrl = `${base}/v1/chat/completions`
      } else {
        transformedBody = anthropicToOpenaiResponses(anthropicReq)
        upstreamUrl = `${base}/v1/responses`
      }

      // Call upstream with transformed request
      const directOpts = getDirectFetchOptions()
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(transformedBody),
        signal: AbortSignal.timeout(30000),
        ...directOpts,
      })

      if (!response.ok) {
        const latencyMs = Date.now() - start
        const errText = await response.text().catch(() => '')
        return { success: false, latencyMs, modelUsed: modelId, httpStatus: response.status,
          error: `Upstream HTTP ${response.status}: ${errText.slice(0, 200)}` }
      }

      // Transform response back to Anthropic format
      const responseBody = await response.json()
      const anthropicRes = format === 'openai_chat'
        ? openaiChatToAnthropic(responseBody, modelId)
        : openaiResponsesToAnthropic(responseBody, modelId)

      const latencyMs = Date.now() - start

      // Validate the final Anthropic response
      if (anthropicRes.type !== 'message' || !Array.isArray(anthropicRes.content)) {
        return { success: false, latencyMs, modelUsed: modelId,
          error: 'Proxy transform produced invalid Anthropic response' }
      }

      return { success: true, latencyMs, modelUsed: anthropicRes.model || modelId, httpStatus: response.status }
    } catch (err: unknown) {
      const latencyMs = Date.now() - start
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { success: false, latencyMs, error: 'Proxy pipeline timed out (30s)', modelUsed: modelId }
      }
      return { success: false, latencyMs, error: err instanceof Error ? err.message : String(err), modelUsed: modelId }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────

function buildDirectTestRequest(
  base: string,
  apiKey: string,
  modelId: string,
  format: ApiFormat,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const prompt = 'Say "ok" and nothing else.'

  if (format === 'openai_chat') {
    return {
      url: `${base}/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: prompt }] },
    }
  }
  if (format === 'openai_responses') {
    return {
      url: `${base}/v1/responses`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: { model: modelId, max_output_tokens: 16, input: [{ type: 'message', role: 'user', content: prompt }] },
    }
  }
  // anthropic
  return {
    url: `${base}/v1/messages`,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: prompt }] },
  }
}

function validateResponseBody(
  body: Record<string, unknown> | null,
  format: ApiFormat,
): { ok: true; model?: string } | { ok: false; error: string } {
  if (!body) return { ok: false, error: 'Empty response — not a valid API endpoint' }
  if (body.error && typeof body.error === 'object') {
    return { ok: false, error: ((body.error as Record<string, unknown>).message as string) || 'Error in response body' }
  }

  if (format === 'openai_chat') {
    if (!Array.isArray(body.choices) || body.choices.length === 0) {
      return { ok: false, error: 'Response missing choices — not a valid Chat Completions endpoint' }
    }
    return { ok: true, model: (body.model as string) || undefined }
  }
  if (format === 'openai_responses') {
    if (!Array.isArray(body.output)) {
      return { ok: false, error: 'Response missing output — not a valid Responses API endpoint' }
    }
    return { ok: true, model: (body.model as string) || undefined }
  }
  // anthropic
  if (body.type !== 'message' || !Array.isArray(body.content)) {
    return { ok: false, error: 'Not a valid Anthropic Messages endpoint' }
  }
  return { ok: true, model: (body.model as string) || undefined }
}

