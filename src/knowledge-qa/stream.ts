/**
 * 单会话 WebSocket 流式对话（精简自 j2agent-ui stream/service + dispatcher）。
 */
import { ref, type Ref } from 'vue'
import { buildChatWebSocketUrl, fetchContextId, mergeSrcFiles } from './api'
import { knowledgeQaConfig } from './config'
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
/** 当前轮次唯一 assistant 气泡下标（对齐 j2a，避免同轮分裂） */
let activeTurnAssistantIndex: number | null = null

/** 拆除 WebSocket，避免晚到消息污染 UI */
function detachWebSocket(ws: WebSocket | undefined, interrupt = false) {
  if (!ws) {
    return
  }
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, interrupt ? 'user interrupt' : 'client detach')
    }
  } catch {
    /* ignore */
  }
  ws.onopen = null
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
}

function isBusyState(state: AgentState | null): boolean {
  return state != null && (BUSY_AGENT_STATES as AgentState[]).includes(state)
}

function isTerminal(state: AgentState | null): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED'
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
  session.isBusy.value = isBusyState(event.state)

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
    session.isBusy.value = false
    session.connecting.value = false
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
      if (server.content) {
        assistant.content = (assistant.content ?? '') + server.content
      }
    }
  }

  if (isTerminal(event.state) || event.phase === 'COMPLETE') {
    // 锚点保留到下一轮发送时再清，避免终态后晚到 delta 再拆气泡
    finishActiveAssistant(session)
    session.isBusy.value = false
  }
}

/** 用户主动停止当前轮次 */
export function stopTurn(session: KbQaSession) {
  turnToken = Symbol('stopped')
  detachWebSocket(activeWs, true)
  activeWs = undefined
  finishActiveAssistant(session)
  session.agentState.value = 'CANCELLED'
  session.isBusy.value = false
  session.sending.value = false
  session.connecting.value = false
}

/**
 * 新建对话：停止当前轮次、清空消息，并向服务端申请新的 contextId。
 * @returns 是否成功拿到新 id（失败时 contextId 为空，下次发送会再申请）
 */
export async function resetSession(
  session: KbQaSession,
  locale: 'zh' | 'en'
): Promise<boolean> {
  stopTurn(session)
  session.messages.value = []
  clearActiveTurnAssistantIndex()
  session.agentState.value = null
  session.errorMessage.value = null
  session.contextId.value = undefined
  session.connecting.value = true
  try {
    session.contextId.value = await fetchContextId(locale)
    return true
  } catch (error) {
    console.error('[knowledge-qa] resetSession fetchContextId failed', error)
    session.errorMessage.value =
      locale === 'zh'
        ? '无法创建新会话，请检查网络或后端 CORS'
        : 'Failed to create a new session. Check network or CORS.'
    return false
  } finally {
    session.connecting.value = false
  }
}

/**
 * 发送用户问题并开启流式回合。
 * @returns 是否已成功开转（false 表示被锁拒绝或启动失败，调用方可恢复输入框）
 */
export async function startTurn(
  session: KbQaSession,
  content: string,
  locale: 'zh' | 'en'
): Promise<boolean> {
  const trimmed = content.trim()
  // 同步占锁：须在任何 await 之前，避免双击 / 连按 Enter 重复提交
  if (!trimmed || session.isBusy.value || session.sending.value) {
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
  const userMsg: KbMessage = {
    index: session.messages.value.length,
    role: 'user',
    content: trimmed
  }
  session.messages.value.push(userMsg)
  ensureAssistant(session)

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
        session.isBusy.value = false
        session.connecting.value = false
        session.agentState.value = 'FAILED'
        // 用户气泡已上屏，返回 true 避免输入框回填重复
        return true
      }
    }
    if (!session.sending.value) {
      // 申请 contextId 期间被 stop
      session.isBusy.value = false
      session.connecting.value = false
      return true
    }

    const contextId = session.contextId.value

    const request: KbChatRequest = {
      contextId,
      messages: [
        {
          index: userMsg.index,
          role: 'user',
          content: trimmed
        }
      ],
      retrievalKb: true,
      systemPrompt: 'GENERAL_ASSISTANT',
      knowledgeCollections: [knowledgeQaConfig.knowledgeBaseId]
    }

    const token = Symbol('chat-ws-turn')
    turnToken = token
    detachWebSocket(activeWs)
    activeWs = undefined

    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const isCurrent = () => turnToken === token

    const markConnected = () => {
      if (isCurrent()) {
        session.connecting.value = false
        if (!session.agentState.value) {
          session.agentState.value = 'THINKING'
        }
      }
    }

    const failHandshake = () => {
      if (!isCurrent()) {
        return
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      session.errorMessage.value =
        locale === 'zh' ? '连接失败，请稍后重试' : 'Connection failed'
      const assistant = ensureAssistant(session)
      if (!assistant.content.trim()) {
        assistant.content = session.errorMessage.value
      }
      assistant.streaming = false
      session.isBusy.value = false
      session.connecting.value = false
      session.agentState.value = 'FAILED'
      activeWs = undefined
    }

    const connect = (attempt: number, resume = false) => {
      if (!isCurrent() || isTerminal(session.agentState.value)) {
        return
      }
      // 重试建联时重新展示连接态
      session.connecting.value = true
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
            retryTimer = setTimeout(() => connect(attempt + 1, resume), delay)
            return
          }
          failHandshake()
          return
        }
        if (isTerminal(session.agentState.value)) {
          session.connecting.value = false
          activeWs = undefined
          return
        }
        // 流中断：尝试 resume
        activeWs = undefined
        const delay =
          WS_HANDSHAKE_RETRY_DELAYS[
            Math.min(attempt, WS_HANDSHAKE_RETRY_DELAYS.length - 1)
          ]
        retryTimer = setTimeout(() => connect(attempt + 1, true), delay)
      }
    }

    connect(0)
    return true
  } finally {
    session.sending.value = false
  }
}
