/**
 * 知识库问答组件公共导出（对齐 j2agent knowledge_qa_assistant 嵌入能力）。
 */
export { default as KbQaWidget } from './KbQaWidget.vue'
export { knowledgeQaConfig, KNOWLEDGE_QA_ASSISTANT_ID } from './config'
export {
  fetchContextId,
  fetchQaTemplate,
  stopChatTurn,
  formatSrcFileLabel,
  getBackendBaseUrl,
  type KbHotQuestion
} from './api'
export {
  createKbQaSession,
  startTurn,
  stopTurn,
  resetSession,
  cutSessionImmediately,
  type KbQaSession
} from './stream'
export { kbQaText, type KbQaLang, type KbQaCopy } from './i18n'
export type { KbMessage, KbSrcFile, AgentState, KbAskQuestion } from './types'
