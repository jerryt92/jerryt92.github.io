/**
 * 单会话 WebSocket 流式对话（精简自 j2agent-ui stream/service + dispatcher）。
 */
import { ref, type Ref } from 'vue'
import { buildChatWebSocketUrl, fetchContextId, mergeSrcFiles, stopChatTurn } from './api'
import { knowledgeQaConfig } from './config'
import { resetStreamMarkdownCache } from './streamMarkdown'
import type {
  AgentState,
  AgentUiEventEnvelope,
  KbChatRequest,
  KbMessage
} from './types'
import { BUSY_AGENT_STATES } from './types'

export type KbQaSession = {
  contextId: Ref<string | undefined>
  messages: Ref<KbMessage[]>
  agentState: Ref<AgentState | null>
  isBusy: Ref<boolean>
  errorMessage: Ref<string | null>
  /** 同步占坑锁：从点击发送到回合启动完成，防重复提交 */
  sending: Ref<boolean>
  /** WebSocket 建联中（含申请 contextId），用于建联动画 */
  connecting: Ref<boolean>
}

const WS_HANDSHAKE_RETRY_DELAYS = [500, 1500, 3000] as const

/** 创建空白会话状态（仅内存，刷新页面即新会话） */
export function createKbQaSession(): KbQaSession {
  return {
    contextId: ref(undefined),
    messages: ref([]),
    agentState: ref(null),
    isBusy: ref(false),
    errorMessage: ref(null),
    sending: ref(false),
    connecting: ref(false)
  }
}

let activeWs: WebSocket | undefined
let turnToken: symbol | undefined
/** WS 重连定时器，新建对话 / 停止时须清除 */
let wsRetryTimer: ReturnType<typeof setTimeout> | undefined
/** 新建对话代次，用于丢弃过期的 contextId 申请 */
let resetEpoch = 0
/** 当前轮次唯一 assistant 气泡下标（对齐 j2a，避免同轮分裂） */
let activeTurnAssistantIndex: number | null = null

/** 清除 WS 重连定时器 */
function clearWsRetryTimer() {
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer)
    wsRetryTimer = undefined
  }
}

/** 拆除 WebSocket，避免晚到消息污染 UI */
function detachWebSocket(ws: WebSocket | undefined, interrupt = false) {
  if (!ws) {
    return
  }
  // 先卸回调，避免 close 同步触发 onclose/onmessage 把 busy 写回
  ws.onopen = null
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, interrupt ? 'user interrupt' : 'client detach')
    }
  } catch {
    /* ignore */
  }
}

/** 强制会话回到空闲（新建对话 / 中断过期的 startTurn 时调用） */
function forceSessionIdle(session: KbQaSession) {
  session.agentState.value = 'CANCELLED'
  session.isBusy.value = false
  session.sending.value = false
  session.connecting.value = false
}

function isBusyState(state: AgentState | null): boolean {
  return state != null && (BUSY_AGENT_STATES as AgentState[]).includes(state)
}

function isTerminal(state: AgentState | null): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED'
}

/** WebSocket 是否仍处于握手中或已连接 */
function isWsLive(): boolean {
  return (
    activeWs != null &&
    (activeWs.readyState === WebSocket.OPEN ||
      activeWs.readyState === WebSocket.CONNECTING)
  )
}

/**
 * 同步轮次忙碌态：Agent 非终态 busy，或 WS 仍存活（对齐 j2a，避免 phase=COMPLETE 误放行）。
 */
function syncTurnBusy(session: KbQaSession) {
  if (isTerminal(session.agentState.value)) {
    session.isBusy.value = false
    return
  }
  session.isBusy.value =
    isBusyState(session.agentState.value) || isWsLive()
}

/** 最后一条 user 消息的下标 */
function findLastUserIndex(list: KbMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') {
      return i
    }
  }
  return -1
}

/**
 * 复用最后一条 user 之后、仍为空的 assistant（含乐观占位），避免同轮再推新气泡。
 */
function findReusableEmptyAssistantIndex(list: KbMessage[]): number | null {
  const lastUserIdx = findLastUserIndex(list)
  for (let i = list.length - 1; i > lastUserIdx; i--) {
    const msg = list[i]
    if (
      msg.role === 'assistant' &&
      !msg.content?.trim() &&
      !msg.reasoningContent?.trim()
    ) {
      return i
    }
  }
  return null
}

/** 清空本轮气泡锚点（新轮次发送 / 重置会话时调用） */
function clearActiveTurnAssistantIndex() {
  activeTurnAssistantIndex = null
}

/** 当前轮次 assistant 的 message.index；无锚点或越界时返回 -1 */
export function getActiveTurnAssistantMessageIndex(
  session: KbQaSession
): number {
  if (activeTurnAssistantIndex === null) {
    return -1
  }
  const msg = session.messages.value[activeTurnAssistantIndex]
  return msg?.role === 'assistant' ? msg.index : -1
}

/**
 * 确保当前轮次仅有一条 assistant 气泡（整轮锚点，不依赖 streaming 标志）。
 */
function ensureAssistant(session: KbQaSession): KbMessage {
  const list = session.messages.value
  const idx = activeTurnAssistantIndex
  if (idx !== null && idx >= 0 && idx < list.length) {
    const anchored = list[idx]
    if (anchored?.role === 'assistant') {
      anchored.streaming = true
      return anchored
    }
  }

  const reusableIdx = findReusableEmptyAssistantIndex(list)
  if (reusableIdx !== null) {
    activeTurnAssistantIndex = reusableIdx
    const reused = list[reusableIdx]
    reused.streaming = true
    return reused
  }

  const msg: KbMessage = {
    index: list.length,
    role: 'assistant',
    content: '',
    reasoningContent: '',
    srcFile: [],
    streaming: true
  }
  list.push(msg)
  activeTurnAssistantIndex = list.length - 1
  return msg
}

/** 结束本轮流式标记（不新建气泡） */
function finishActiveAssistant(session: KbQaSession) {
  const list = session.messages.value
  const idx = activeTurnAssistantIndex
  if (idx !== null && idx >= 0 && idx < list.length && list[idx].role === 'assistant') {
    list[idx].streaming = false
    return
  }
  const last = list[list.length - 1]
  if (last?.role === 'assistant') {
    last.streaming = false
  }
}

function applyEnvelope(session: KbQaSession, event: AgentUiEventEnvelope) {
  const payload = event.payload
  if (
    event.state === 'IDLE' &&
    event.eventType === 'SYSTEM' &&
    payload &&
    typeof payload === 'object' &&
    (payload as { notice?: string }).notice === 'connected'
  ) {
    return
  }

  session.agentState.value = event.state || null

  if (event.state === 'FAILED' && event.eventType === 'SYSTEM') {
    const code = payload?.errorCode
    const rawMsg = typeof payload?.errorMessage === 'string' ? payload.errorMessage : ''
    const msg =
      rawMsg.includes('does not own the contextId')
        ? '会话归属校验失败：请部署并重启 j2agent（修复 app_user.id char 空格）'
        : rawMsg ||
          (code === 'knowledgeCollectionsRequired'
            ? '请配置有效的知识库 ID'
            : '对话失败，请稍后重试')
    session.errorMessage.value = msg
    const assistant = ensureAssistant(session)
    if (!assistant.content.trim()) {
      assistant.content = msg
    }
    assistant.streaming = false
    session.connecting.value = false
    syncTurnBusy(session)
    return
  }

  if (
    event.state === 'THINKING' ||
    event.state === 'CALLING_TOOL' ||
    event.state === 'LOAD_SKILL' ||
    event.state === 'STREAMING_TEXT'
  ) {
    ensureAssistant(session)
  }

  if (event.eventType === 'MESSAGE' && payload) {
    if (payload.snapshot) {
      const assistant = ensureAssistant(session)
      assistant.content = payload.answerContent ?? ''
      assistant.reasoningContent = payload.reasoningContent ?? ''
    } else if (payload.message?.role === 'assistant') {
      const assistant = ensureAssistant(session)
      const server = payload.message
      if (server.srcFile?.length) {
        assistant.srcFile = mergeSrcFiles(assistant.srcFile, server.srcFile)
      }
      if (server.reasoningContent) {
        assistant.reasoningContent =
          (assistant.reasoningContent ?? '') + server.reasoningContent
      }
      if (server.pendingQuestion) {
        assistant.pendingQuestion = server.pendingQuestion
      }
      if (server.content) {
        assistant.content = (assistant.content ?? '') + server.content
      }
    }
  }

  if (isTerminal(event.state)) {
    finishActiveAssistant(session)
    session.connecting.value = false
  }

  syncTurnBusy(session)
}

/** 用户主动停止当前轮次（保留消息与 contextId） */
export function stopTurn(session: KbQaSession, locale: 'zh' | 'en' = 'zh') {
  const contextId = session.contextId.value
  turnToken = Symbol('stopped')
  clearWsRetryTimer()
  detachWebSocket(activeWs, true)
  activeWs = undefined
  finishActiveAssistant(session)
  session.agentState.value = 'CANCELLED'
  forceSessionIdle(session)
  if (contextId) {
    void stopChatTurn(contextId, locale)
  }
}

/**
 * 同步切断当前对话：拆 WS、清空消息、作废 contextId（新建对话首步调用）。
 */
export function cutSessionImmediately(session: KbQaSession) {
  resetEpoch += 1
  turnToken = Symbol('cut')
  clearWsRetryTimer()
  detachWebSocket(activeWs, true)
  activeWs = undefined
  finishActiveAssistant(session)
  session.messages.value = []
  clearActiveTurnAssistantIndex()
  resetStreamMarkdownCache()
  session.agentState.value = null
  session.errorMessage.value = null
  session.contextId.value = undefined
  forceSessionIdle(session)
}

/**
 * 新建对话：立即切断上一轮，并向服务端申请新的 contextId。
 * 注意：此处仅走 REST，不占用 connecting（该标志专用于 WS 建联）。
 */
export async function resetSession(
  session: KbQaSession,
  locale: 'zh' | 'en'
): Promise<boolean> {
  cutSessionImmediately(session)
  const epoch = resetEpoch
  try {
    const contextId = await fetchContextId(locale)
    if (epoch !== resetEpoch) {
      return false
    }
    session.contextId.value = contextId
    return true
  } catch (error) {
    if (epoch !== resetEpoch) {
      return false
    }
    console.error('[knowledge-qa] resetSession fetchContextId failed', error)
    session.errorMessage.value =
      locale === 'zh'
        ? '无法创建新会话，请检查网络或后端 CORS'
        : 'Failed to create a new session. Check network or CORS.'
    return false
  }
}

/**
 * 发送用户问题并开启流式回合。
 * @returns 是否已成功开转（false 表示被锁拒绝或启动失败，调用方可恢复输入框）
 */
export async function startTurn(
  session: KbQaSession,
  content: string,
  locale: 'zh' | 'en',
  options?: { existingUserMessage?: KbMessage }
): Promise<boolean> {
  const trimmed = content.trim()
  const existingUser = options?.existingUserMessage
  const existingContent = existingUser?.content?.trim() ?? ''
  const outboundContent = existingUser ? existingContent : trimmed

  // 同步占锁：须在任何 await 之前，避免双击 / 连按 Enter 重复提交
  if (
    !outboundContent ||
    session.isBusy.value ||
    session.sending.value ||
    session.connecting.value
  ) {
    return false
  }

  session.sending.value = true
  session.isBusy.value = true
  session.connecting.value = true
  session.errorMessage.value = null
  session.agentState.value = null
  // 新轮次：重置锚点后再乐观占位，保证整轮共用一条助手气泡
  clearActiveTurnAssistantIndex()

  // 先上屏用户消息，再建联（避免等 contextId / WS 才出现气泡）
  const userMsg: KbMessage =
    existingUser ??
    {
      index: session.messages.value.length,
      role: 'user',
      content: outboundContent
    }
  if (!existingUser) {
    session.messages.value.push(userMsg)
  }
  ensureAssistant(session)

  const turnEpoch = resetEpoch

  try {
    // 本页生命周期内复用同一 contextId；刷新页面后内存清空，会重新向服务端申请
    if (!session.contextId.value) {
      try {
        session.contextId.value = await fetchContextId(locale)
      } catch (error) {
        console.error('[knowledge-qa] fetchContextId failed', error)
        session.errorMessage.value =
          locale === 'zh'
            ? '无法创建会话，请检查网络或后端 CORS'
            : 'Failed to create session. Check network or CORS.'
        const assistant = ensureAssistant(session)
        if (!assistant.content.trim()) {
          assistant.content = session.errorMessage.value
        }
        assistant.streaming = false
        session.connecting.value = false
        session.agentState.value = 'FAILED'
        syncTurnBusy(session)
        // 用户气泡已上屏，返回 true 避免输入框回填重复
        return true
      }
    }
    if (turnEpoch !== resetEpoch || !session.sending.value) {
      // 申请 contextId 期间被新建对话 / 停止打断
      forceSessionIdle(session)
      return true
    }

    const contextId = session.contextId.value

    const request: KbChatRequest = {
      contextId,
      messages: [
        {
          index: userMsg.index,
          role: 'user',
          content: outboundContent
        }
      ],
      retrievalKb: true,
      systemPrompt: 'GENERAL_ASSISTANT',
      knowledgeCollections: [knowledgeQaConfig.knowledgeBaseId]
    }

    if (turnEpoch !== resetEpoch) {
      forceSessionIdle(session)
      return true
    }

    const token = Symbol('chat-ws-turn')
    turnToken = token
    detachWebSocket(activeWs)
    activeWs = undefined

    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const isCurrent = () => turnToken === token

    const scheduleWsRetry = (fn: () => void, delay: number) => {
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      clearWsRetryTimer()
      wsRetryTimer = setTimeout(() => {
        wsRetryTimer = undefined
        retryTimer = undefined
        fn()
      }, delay)
      retryTimer = wsRetryTimer
    }

    const markConnected = () => {
      if (isCurrent()) {
        session.connecting.value = false
        if (!session.agentState.value) {
          session.agentState.value = 'THINKING'
        }
        syncTurnBusy(session)
      }
    }

    const failHandshake = () => {
      if (!isCurrent()) {
        return
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      clearWsRetryTimer()
      session.errorMessage.value =
        locale === 'zh' ? '连接失败，请稍后重试' : 'Connection failed'
      const assistant = ensureAssistant(session)
      if (!assistant.content.trim()) {
        assistant.content = session.errorMessage.value
      }
      assistant.streaming = false
      session.connecting.value = false
      session.agentState.value = 'FAILED'
      activeWs = undefined
      syncTurnBusy(session)
    }

    const connect = (attempt: number, resume = false) => {
      if (!isCurrent() || isTerminal(session.agentState.value)) {
        return
      }
      // 重试建联时重新展示连接态
      session.connecting.value = true
      syncTurnBusy(session)
      detachWebSocket(activeWs)
      const ws = new WebSocket(
        buildChatWebSocketUrl(contextId, locale, { resume })
      )
      activeWs = ws
      let opened = false

      ws.onopen = () => {
        if (!isCurrent() || activeWs !== ws) {
          return
        }
        opened = true
        markConnected()
        if (!resume) {
          ws.send(JSON.stringify(request))
        }
      }

      ws.onmessage = (event) => {
        if (!isCurrent() || activeWs !== ws) {
          return
        }
        try {
          markConnected()
          const envelope = JSON.parse(event.data) as AgentUiEventEnvelope
          applyEnvelope(session, envelope)
          if (isTerminal(session.agentState.value)) {
            detachWebSocket(ws)
            if (activeWs === ws) {
              activeWs = undefined
            }
            syncTurnBusy(session)
          }
        } catch (error) {
          console.error('[knowledge-qa] parse event failed', error)
        }
      }

      ws.onerror = () => {
        /* onclose 统一处理握手失败 */
      }

      ws.onclose = () => {
        if (!isCurrent() || activeWs !== ws) {
          return
        }
        if (!opened) {
          const delay = WS_HANDSHAKE_RETRY_DELAYS[attempt]
          if (delay !== undefined && !isTerminal(session.agentState.value)) {
            activeWs = undefined
            syncTurnBusy(session)
            scheduleWsRetry(() => connect(attempt + 1, resume), delay)
            return
          }
          failHandshake()
          return
        }
        if (isTerminal(session.agentState.value)) {
          session.connecting.value = false
          activeWs = undefined
          syncTurnBusy(session)
          return
        }
        // 流中断：尝试 resume
        activeWs = undefined
        syncTurnBusy(session)
        const delay =
          WS_HANDSHAKE_RETRY_DELAYS[
            Math.min(attempt, WS_HANDSHAKE_RETRY_DELAYS.length - 1)
          ]
        scheduleWsRetry(() => connect(attempt + 1, true), delay)
      }
    }

    connect(0)
    return true
  } finally {
    session.sending.value = false
  }
}
