<script setup lang="ts">
import MarkdownIt from 'markdown-it'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

type Language = 'zh' | 'en'
type ThemePreference = 'system' | 'light' | 'dark'

const LANGUAGE_STORAGE_KEY = 'site-language'
const THEME_STORAGE_KEY = 'site-theme'

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true
})

const language = ref<Language>(resolveInitialLanguage())
const source = ref('')
const loading = ref(false)
const error = ref('')
const themePreference = ref<ThemePreference>(resolveInitialThemePreference())
const systemPrefersDark = ref(false)
const settingsMenuOpen = ref(false)
const settingsMenuRef = ref<HTMLElement | null>(null)
const settingsMenuCardRef = ref<HTMLElement | null>(null)
let themeMediaQuery: MediaQueryList | null = null

const documentTitle = computed(() =>
  language.value === 'zh' ? 'jerryt92 的主页' : 'jerryt92 Home'
)

const renderedContent = computed(() => markdown.render(displaySource.value))
const displaySource = computed(() => removeInlineLanguageSwitcher(source.value))
const resolvedTheme = computed(() =>
  themePreference.value === 'system'
    ? systemPrefersDark.value
      ? 'dark'
      : 'light'
    : themePreference.value
)

watch(language, async (nextLanguage) => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage)
  document.documentElement.lang = nextLanguage === 'zh' ? 'zh-CN' : 'en'
  document.title = documentTitle.value
  await loadMarkdown()
})

watch(themePreference, (nextTheme) => {
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
})

watch(resolvedTheme, applyResolvedTheme)

onMounted(async () => {
  setupSystemThemeListener()
  document.documentElement.lang = language.value === 'zh' ? 'zh-CN' : 'en'
  document.title = documentTitle.value
  applyResolvedTheme(resolvedTheme.value)
  document.addEventListener('click', handleDocumentClick)
  await loadMarkdown()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  if (!themeMediaQuery) {
    return
  }
  themeMediaQuery.removeEventListener('change', updateSystemTheme)
})

function resolveInitialLanguage(): Language {
  const storedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY)
  if (storedLanguage === 'zh' || storedLanguage === 'en') {
    return storedLanguage
  }

  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function resolveInitialThemePreference(): ThemePreference {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
  if (
    storedTheme === 'system' ||
    storedTheme === 'light' ||
    storedTheme === 'dark'
  ) {
    return storedTheme
  }

  return 'system'
}

function setupSystemThemeListener() {
  themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  updateSystemTheme()
  themeMediaQuery.addEventListener('change', updateSystemTheme)
}

function updateSystemTheme() {
  systemPrefersDark.value = Boolean(themeMediaQuery?.matches)
}

function applyResolvedTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function setLanguage(nextLanguage: Language) {
  language.value = nextLanguage
}

function setThemePreference(nextTheme: ThemePreference) {
  themePreference.value = nextTheme
}

function toggleSettingsMenu() {
  settingsMenuOpen.value = !settingsMenuOpen.value
}

function handleDocumentClick(event: MouseEvent) {
  if (!settingsMenuOpen.value) {
    return
  }

  const target = event.target
  if (
    target instanceof Node &&
    (settingsMenuRef.value?.contains(target) ||
      settingsMenuCardRef.value?.contains(target))
  ) {
    return
  }

  settingsMenuOpen.value = false
}

function markdownUrl() {
  const filename = language.value === 'zh' ? 'README.md' : 'README_en.md'
  return `${import.meta.env.BASE_URL}${filename}`
}

function removeInlineLanguageSwitcher(markdownSource: string) {
  return markdownSource
    .split('\n')
    .filter((line) => !isInlineLanguageSwitcher(line))
    .join('\n')
}

function isInlineLanguageSwitcher(line: string) {
  const normalizedLine = line.trim()
  return (
    normalizedLine === '简体中文 | [English](README_en.md)' ||
    normalizedLine === '[简体中文](README.md) | English'
  )
}

async function loadMarkdown() {
  loading.value = true
  error.value = ''

  try {
    const response = await fetch(markdownUrl(), { cache: 'no-cache' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    source.value = await response.text()
  } catch (loadError) {
    source.value = ''
    error.value =
      language.value === 'zh'
        ? '内容加载失败，请稍后重试。'
        : 'Failed to load content. Please try again.'
    console.error('Failed to load markdown:', loadError)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <header class="site-header" aria-label="Site header">
    <div class="topbar-inner">
      <a class="brand" href="./" aria-label="jerryt92 home">
        <img class="brand-logo" src="/tian-logo.png" alt="jerryt92" />
      </a>

      <div class="toolbar">
        <div class="toolbar-controls">
        <div class="segmented-control" aria-label="Language switcher">
          <button
            type="button"
            :class="{ active: language === 'zh' }"
            :aria-pressed="language === 'zh'"
            @click="setLanguage('zh')"
          >
            中
          </button>
          <button
            type="button"
            :class="{ active: language === 'en' }"
            :aria-pressed="language === 'en'"
            @click="setLanguage('en')"
          >
            EN
          </button>
        </div>

        <div class="segmented-control theme-control" aria-label="Theme switcher">
          <button
            type="button"
            :class="{ active: themePreference === 'system' }"
            :aria-pressed="themePreference === 'system'"
            :title="language === 'zh' ? '跟随系统' : 'System theme'"
            @click="setThemePreference('system')"
          >
            <span class="theme-icon theme-icon-system" aria-hidden="true">A</span>
          </button>
          <button
            type="button"
            :class="{ active: themePreference === 'light' }"
            :aria-pressed="themePreference === 'light'"
            :title="language === 'zh' ? '亮色模式' : 'Light mode'"
            @click="setThemePreference('light')"
          >
            <span class="theme-icon theme-icon-sun" aria-hidden="true">☀︎</span>
          </button>
          <button
            type="button"
            :class="{ active: themePreference === 'dark' }"
            :aria-pressed="themePreference === 'dark'"
            :title="language === 'zh' ? '暗色模式' : 'Dark mode'"
            @click="setThemePreference('dark')"
          >
            <span class="theme-icon theme-icon-moon" aria-hidden="true">☾</span>
          </button>
        </div>
        </div>

        <div ref="settingsMenuRef" class="settings-menu-wrap" @click.stop>
          <button
            type="button"
            class="settings-menu-button"
            :aria-expanded="settingsMenuOpen"
            aria-controls="settings-menu"
            :aria-label="language === 'zh' ? '打开设置菜单' : 'Open settings menu'"
            @click="toggleSettingsMenu"
          >
            <svg
              class="settings-menu-icon"
              aria-hidden="true"
              viewBox="0 0 24 24"
              focusable="false"
            >
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </header>

  <Teleport to="body">
    <div
      v-show="settingsMenuOpen"
      id="settings-menu"
      ref="settingsMenuCardRef"
      class="settings-menu-card"
      role="menu"
      @click.stop
    >
      <div class="settings-menu-title">
        {{ language === 'zh' ? '设置' : 'Settings' }}
      </div>

      <div class="settings-menu-section">
        <div class="settings-menu-label">
          {{ language === 'zh' ? '语言' : 'Language' }}
        </div>
        <div class="segmented-control" aria-label="Language switcher">
          <button
            type="button"
            :class="{ active: language === 'zh' }"
            :aria-pressed="language === 'zh'"
            @click="setLanguage('zh')"
          >
            中
          </button>
          <button
            type="button"
            :class="{ active: language === 'en' }"
            :aria-pressed="language === 'en'"
            @click="setLanguage('en')"
          >
            EN
          </button>
        </div>
      </div>

      <div class="settings-menu-section">
        <div class="settings-menu-label">
          {{ language === 'zh' ? '外观' : 'Appearance' }}
        </div>
        <div class="segmented-control theme-control" aria-label="Theme switcher">
          <button
            type="button"
            :class="{ active: themePreference === 'system' }"
            :aria-pressed="themePreference === 'system'"
            :title="language === 'zh' ? '跟随系统' : 'System theme'"
            @click="setThemePreference('system')"
          >
            <span class="theme-icon theme-icon-system" aria-hidden="true">A</span>
          </button>
          <button
            type="button"
            :class="{ active: themePreference === 'light' }"
            :aria-pressed="themePreference === 'light'"
            :title="language === 'zh' ? '亮色模式' : 'Light mode'"
            @click="setThemePreference('light')"
          >
            <span class="theme-icon theme-icon-sun" aria-hidden="true">☀︎</span>
          </button>
          <button
            type="button"
            :class="{ active: themePreference === 'dark' }"
            :aria-pressed="themePreference === 'dark'"
            :title="language === 'zh' ? '暗色模式' : 'Dark mode'"
            @click="setThemePreference('dark')"
          >
            <span class="theme-icon theme-icon-moon" aria-hidden="true">☾</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <main class="site-shell">
    <section class="content-frame" :aria-busy="loading">
      <div v-if="loading" class="state-panel" role="status">
        {{ language === 'zh' ? '正在加载内容...' : 'Loading content...' }}
      </div>

      <div v-else-if="error" class="state-panel error" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="loadMarkdown">
          {{ language === 'zh' ? '重试' : 'Retry' }}
        </button>
      </div>

      <article
        v-else
        class="markdown-body"
        v-html="renderedContent"
      ></article>
    </section>
  </main>
</template>
