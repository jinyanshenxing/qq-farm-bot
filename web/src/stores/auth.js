import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { login as apiLogin, getMe } from '../api/index.js'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(localStorage.getItem('token') || '')
  const user = ref(JSON.parse(localStorage.getItem('user') || 'null'))

  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.role === 'admin')
  const username = computed(() => user.value?.username || '')
  const allowedUins = computed(() => {
    const str = user.value?.allowedUins || ''
    return str.split(',').map(s => s.trim()).filter(Boolean)
  })

  async function login(uname, password) {
    const res = await apiLogin(uname, password)
    token.value = res.data.token
    user.value = res.data.user
    localStorage.setItem('token', res.data.token)
    localStorage.setItem('user', JSON.stringify(res.data.user))
    return res.data
  }

  function logout() {
    token.value = ''
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('user')
  }

  async function checkAuth() {
    if (!token.value) return false
    try {
      const res = await getMe()
      user.value = res.data
      return true
    } catch {
      logout()
      return false
    }
  }

  return { token, user, isLoggedIn, isAdmin, username, allowedUins, login, logout, checkAuth }
})
