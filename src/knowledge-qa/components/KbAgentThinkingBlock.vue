<script setup lang="ts">
/**
 * 助手思考过程折叠块（精简自 j2a AgentThinkingBlock）。
 */
import { computed, nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 模型 reasoning 全文 */
    content: string
    /** 折叠标题 */
    title: string
    /** 当前轮次是否仍在流式输出 */
    active?: boolean
  }>(),
  {
    active: false
  }
)

const expanded = ref(false)
const previewRef = ref<HTMLElement | null>(null)

const visible = computed(() => !!props.content?.trim())

/** 折叠预览区滚到底部，跟随流式 reasoning */
function scrollPreviewToBottom() {
  const el = previewRef.value
  if (!el) {
    return
  }
  el.scrollTop = el.scrollHeight
}

watch(
  () => [props.content, props.active, expanded.value] as const,
  () => {
    if (expanded.value || !props.active) {
      return
    }
    void nextTick(scrollPreviewToBottom)
  }
)
</script>

<template>
  <div
    v-if="visible"
    class="kb-qa-thinking"
    :class="{ expanded, 'is-active': active }"
  >
    <button
      type="button"
      class="kb-qa-thinking-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="kb-qa-thinking-title">{{ title }}</span>
      <span class="kb-qa-thinking-caret" :class="{ expanded }" aria-hidden="true" />
    </button>
    <div v-if="!expanded" ref="previewRef" class="kb-qa-thinking-preview">
      <div class="kb-qa-thinking-text">{{ content }}</div>
    </div>
    <div v-else class="kb-qa-thinking-body">
      <div class="kb-qa-thinking-text">{{ content }}</div>
    </div>
  </div>
</template>

<style scoped>
.kb-qa-thinking {
  margin-bottom: 8px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--n-color-text) 10%, transparent);
  background: color-mix(in srgb, var(--n-color-bg-subtle) 88%, transparent);
  overflow: hidden;
  font-size: 12px;
  line-height: 1.55;
}

.kb-qa-thinking.is-active {
  box-shadow: 0 4px 16px color-mix(in srgb, var(--n-color-text) 8%, transparent);
}

.kb-qa-thinking-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: color-mix(in srgb, var(--n-color-text) 4%, transparent);
  color: var(--n-color-text-secondary);
  font: inherit;
  font-size: 12px;
  font-style: italic;
  text-align: left;
  cursor: pointer;
}

.kb-qa-thinking-toggle:hover {
  background: color-mix(in srgb, var(--n-color-text) 8%, transparent);
}

.kb-qa-thinking-title {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.kb-qa-thinking-caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid currentColor;
  transition: transform 0.18s ease;
}

.kb-qa-thinking-caret.expanded {
  transform: rotate(180deg);
}

.kb-qa-thinking-preview {
  max-height: 72px;
  overflow-y: auto;
  padding: 4px 10px 8px;
  border-top: 1px solid color-mix(in srgb, var(--n-color-text) 8%, transparent);
  scroll-behavior: smooth;
  scrollbar-width: none;
}

.kb-qa-thinking-preview::-webkit-scrollbar {
  display: none;
}

.kb-qa-thinking-body {
  padding: 4px 10px 8px;
  border-top: 1px solid color-mix(in srgb, var(--n-color-text) 8%, transparent);
}

.kb-qa-thinking-text {
  white-space: pre-wrap;
  word-break: break-word;
  font-style: italic;
  color: var(--n-color-text-tertiary);
}
</style>
