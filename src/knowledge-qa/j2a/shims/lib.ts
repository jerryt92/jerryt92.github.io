/**
 * 替代 @ai-system/lib 的精简 i18n。
 * 签名对齐 j2a：t(key, params?, fallback?)
 */
const messages: Record<string, string> = {
  'markdownRenderer.copyCode': '复制代码',
  'markdownRenderer.copy': '复制',
  'markdownRenderer.diagramError.copyAllDiagnostics': '复制诊断信息',
  'markdownRenderer.copyAll': '全部复制',
  'markdownRenderer.diagramError.viewDetails': '查看错误详情',
  'mdViewer.loading': '加载中…',
  'mdViewer.loadFailed': '无法加载文档',
  'mdViewer.download': '下载',
  'mdViewer.close': '关闭预览',
  'mdViewer.prev': '上一份',
  'mdViewer.next': '下一份',
  'diagramPreview.saveSvg': '保存 SVG',
  'common.success': '成功',
  'common.fail': '失败'
}

const enMessages: Record<string, string> = {
  'markdownRenderer.copyCode': 'Copy code',
  'markdownRenderer.copy': 'Copy',
  'markdownRenderer.diagramError.copyAllDiagnostics': 'Copy diagnostics',
  'markdownRenderer.copyAll': 'Copy all',
  'markdownRenderer.diagramError.viewDetails': 'View error details',
  'mdViewer.loading': 'Loading…',
  'mdViewer.loadFailed': 'Failed to load document',
  'mdViewer.download': 'Download',
  'mdViewer.close': 'Close preview',
  'mdViewer.prev': 'Previous document',
  'mdViewer.next': 'Next document',
  'diagramPreview.saveSvg': 'Save SVG',
  'common.success': 'Success',
  'common.fail': 'Failed'
}

let currentLang: 'zh' | 'en' = 'zh'

/** 供悬浮框切换语言时同步 j2a 组件文案 */
export function setJ2aLocale(lang: 'zh' | 'en') {
  currentLang = lang
}

export function t(
  key: string,
  _params?: unknown,
  fallback?: string
): string {
  const table = currentLang === 'en' ? enMessages : messages
  return table[key] ?? fallback ?? key
}

export const locale = {
  lang: {
    value: currentLang
  }
}
