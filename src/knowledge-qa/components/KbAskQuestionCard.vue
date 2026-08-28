<script setup lang="ts">
/**
 * Agent 澄清问题卡片（精简自 j2a AskQuestionCard）。
 */
import { ref, watch } from 'vue'
import type { KbAskQuestion } from '../types'

const props = withDefaults(
  defineProps<{
    /** 待回答的澄清问题 */
    question: KbAskQuestion
    /** 是否禁用交互 */
    disabled?: boolean
    /** 已提交、等待回合结束 */
    pending?: boolean
    /** 自定义输入占位符 */
    customPlaceholder: string
    /** 发送按钮无障碍文案 */
    sendLabel: string
    /** 空答案提示 */
    emptyHint: string
  }>(),
  {
    disabled: false,
    pending: false
  }
)

const emit = defineEmits<{
  answer: [answer: string]
}>()

const customAnswer = ref('')
const emptyVisible = ref(false)

watch(
  () => props.question,
  () => {
    customAnswer.value = ''
    emptyVisible.value = false
  }
)

/** 提交选项或自定义答案 */
function emitAnswer(answer: string) {
  const normalized = answer.trim()
  if (!normalized) {
    emptyVisible.value = true
    return
  }
  emptyVisible.value = false
  emit('answer', normalized)
}

function submitCustomAnswer() {
  emitAnswer(customAnswer.value)
}
</script>

<template>
  <div class="kb-qa-ask-card">
    <p class="kb-qa-ask-title">{{ question.question }}</p>
    <div v-if="question.options?.length" class="kb-qa-ask-options">
      <button
        v-for="option in question.options"
        :key="option"
        type="button"
        class="kb-qa-ask-option"
        :disabled="disabled || pending"
        @click.stop="emitAnswer(option)"
      >
        {{ option }}
      </button>
    </div>
    <div class="kb-qa-ask-custom">
      <input
        v-model="customAnswer"
        type="text"
        class="kb-qa-ask-input"
        :placeholder="customPlaceholder"
        :disabled="disabled || pending"
        maxlength="2000"
        @keydown.enter.prevent="submitCustomAnswer"
      />
      <button
        type="button"
        class="kb-qa-ask-send"
        :disabled="disabled || pending"
        :aria-label="sendLabel"
        @click.stop="submitCustomAnswer"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
          <path
            d="M5 12h12M13 6l6 6-6 6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <p v-if="emptyVisible" class="kb-qa-ask-empty">{{ emptyHint }}</p>
  </div>
</template>

<style scoped>
.kb-qa-ask-card {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--n-color-primary) 28%, transparent);
  background: color-mix(in srgb, var(--n-color-primary) 6%, transparent);
}

.kb-qa-ask-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--n-color-text-primary);
  overflow-wrap: anywhere;
}

.kb-qa-ask-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.kb-qa-ask-option {
  max-width: 100%;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--n-color-primary) 35%, transparent);
  background: color-mix(in srgb, var(--n-color-bg-elevated) 92%, transparent);
  color: var(--n-color-primary);
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
}

.kb-qa-ask-option:hover:not(:disabled) {
  background: color-mix(in srgb, var(--n-color-primary) 10%, transparent);
}

.kb-qa-ask-option:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.kb-qa-ask-custom {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  margin-top: 10px;
}

.kb-qa-ask-input {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--n-color-text) 12%, transparent);
  background: var(--n-color-bg-elevated);
  color: var(--n-color-text-primary);
  font: inherit;
  font-size: 13px;
}

.kb-qa-ask-input:disabled {
  opacity: 0.6;
}

.kb-qa-ask-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--n-color-primary);
  color: #fff;
  cursor: pointer;
}

.kb-qa-ask-send:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.kb-qa-ask-empty {
  margin: 8px 0 0;
  font-size: 12px;
  color: #ff3b30;
}
</style>
