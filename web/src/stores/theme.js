import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const useThemeStore = defineStore('theme', () => {
  const isDark = ref(localStorage.getItem('theme') !== 'light')

  function toggle() {
    isDark.value = !isDark.value
  }

  function applyTheme() {
    const html = document.documentElement
    if (isDark.value) {
      html.classList.add('dark')
      html.dataset.theme = 'dark'
    } else {
      html.classList.remove('dark')
      html.dataset.theme = 'light'
    }
    localStorage.setItem('theme', isDark.value ? 'dark' : 'light')
  }

  // Watch and apply
  watch(isDark, applyTheme, { immediate: true })

  return { isDark, toggle }
})
