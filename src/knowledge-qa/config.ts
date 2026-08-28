/**
 * 通用知识库问答悬浮框配置。
 * knowledgeBaseId 对应后端 knowledgeCollections 的 collection 名（非仓库 UUID）。
 */
export const KNOWLEDGE_QA_ASSISTANT_ID = 'knowledge_qa_assistant'

export const knowledgeQaConfig = {
  /** 知识库 collection id */
  knowledgeBaseId:
    import.meta.env.VITE_J2AGENT_KB_COLLECTION || 'kb_j2agent_docs',
  /**
   * 后端根地址（无尾斜杠）。
   * 生产静态站直连该地址；本地开发默认走 Vite 同源代理，可避免 CORS。
   */
  backendBaseUrl:
    import.meta.env.VITE_J2AGENT_BACKEND_URL || 'https://j2agent.jerryt92.top',
  /**
   * 开发态是否把 REST/WS/文件请求改写到当前 Origin，由 Vite proxy 转发。
   * 生产构建始终直连 backendBaseUrl。
   */
  useDevProxy: import.meta.env.VITE_J2AGENT_USE_DEV_PROXY !== 'false',
  /** API Key（apikey-...），会打进静态站点，请使用权限受限账号 */
  apiKey:
    import.meta.env.VITE_J2AGENT_API_KEY ||
    'apikey-AaBDnP4rdc2FoKNnSZ7cxw.KS1oZZvRsZFyriXueTAqOoW-JoEHsOr9VYKI_lvwyfg',
  /** 品牌跳转地址（Powered by J2Agent） */
  brandUrl:
    import.meta.env.VITE_J2AGENT_BRAND_URL || 'https://github.com/j2agent-ai/j2agent'
} as const

/** 是否走同源代理（仅 Vite 开发态） */
export function shouldUseDevProxy(): boolean {
  return Boolean(import.meta.env.DEV && knowledgeQaConfig.useDevProxy)
}

/**
 * 实际请求根地址：开发代理时返回空字符串（同源相对路径）。
 */
export function resolveRequestBaseUrl(): string {
  if (shouldUseDevProxy()) {
    return ''
  }
  return knowledgeQaConfig.backendBaseUrl.replace(/\/+$/, '')
}

/** 配置中的直连后端 Origin（用于把绝对链接改写为同源路径） */
export function resolveConfiguredBackendOrigin(): string {
  try {
    return new URL(knowledgeQaConfig.backendBaseUrl).origin
  } catch {
    return knowledgeQaConfig.backendBaseUrl.replace(/\/+$/, '')
  }
}
