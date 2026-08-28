/** Agent 向用户发起的澄清问题（ask_question 工具） */
export type KbAskQuestion = {
  type: 'ask_question'
  version: number
  question: string
  options: string[]
}

/** 聊天消息（精简自 j2agent MessageDto） */
export type KbMessage = {
  index: number
  role: 'user' | 'assistant'
  content: string
  reasoningContent?: string
  srcFile?: KbSrcFile[]
  /** assistant 触发的待回答澄清问题 */
  pendingQuestion?: KbAskQuestion
  /** 是否为流式进行中的助手气泡 */
  streaming?: boolean
}

/** RAG 来源文件 */
export type KbSrcFile = {
  fullFileName: string
  relativePath?: string
  url: string
}

/** WebSocket 首包请求 */
export type KbChatRequest = {
  contextId: string
  messages: Array<{
    index: number
    role: 'user'
    content: string
  }>
  retrievalKb: boolean
  systemPrompt: 'GENERAL_ASSISTANT'
  knowledgeCollections: string[]
}

export type AgentState =
  | 'IDLE'
  | 'AGENT_ORCHESTRATING'
  | 'THINKING'
  | 'STREAMING_TEXT'
  | 'CALLING_TOOL'
  | 'LOAD_SKILL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type AgentEventPhase = 'START' | 'DELTA' | 'PATCH' | 'COMPLETE' | 'ERROR'
export type AgentEventType = 'MESSAGE' | 'TOOL' | 'PROGRESS' | 'NOTICE' | 'SYSTEM'

/** Agent UI 事件信封 */
export type AgentUiEventEnvelope = {
  eventId: string
  contextId: string
  turnId: string
  seq: number
  state: AgentState
  phase: AgentEventPhase
  eventType: AgentEventType
  payload?: {
    message?: {
      role?: string
      content?: string
      reasoningContent?: string
      srcFile?: KbSrcFile[]
      pendingQuestion?: KbAskQuestion
    }
    error?: boolean
    errorCode?: string
    errorMessage?: string
    answerContent?: string
    reasoningContent?: string
    snapshot?: boolean
    notice?: string
  }
  ts: number
}

/** 轮次忙碌态 */
export const BUSY_AGENT_STATES: AgentState[] = [
  'AGENT_ORCHESTRATING',
  'THINKING',
  'STREAMING_TEXT',
  'CALLING_TOOL',
  'LOAD_SKILL'
]
