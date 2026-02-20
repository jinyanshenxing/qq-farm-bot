/**
 * Socket.io 客户端封装
 */
import { io } from 'socket.io-client'
import { reactive, ref } from 'vue'

// 连接状态
export const connected = ref(false)

// 创建 Socket.io 连接
const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionAttempts: Infinity,
})

socket.on('connect', () => {
  connected.value = true
  console.log('[Socket] 已连接')
})

socket.on('disconnect', () => {
  connected.value = false
  console.log('[Socket] 已断开')
})

// ============ 事件订阅 ============

const eventHandlers = new Map()

/**
 * 注册事件监听
 * @param {string} event - 事件名
 * @param {Function} handler - 回调
 */
export function onEvent(event, handler) {
  if (!eventHandlers.has(event)) {
    eventHandlers.set(event, new Set())
    socket.on(event, (...args) => {
      const handlers = eventHandlers.get(event)
      if (handlers) handlers.forEach(h => h(...args))
    })
  }
  eventHandlers.get(event).add(handler)
}

/**
 * 取消事件监听
 */
export function offEvent(event, handler) {
  const handlers = eventHandlers.get(event)
  if (handlers) handlers.delete(handler)
}

// ============ 日志订阅 ============

export function subscribeLogs(uin) {
  socket.emit('logs:subscribe', uin)
}

export function unsubscribeLogs(uin) {
  socket.emit('logs:unsubscribe', uin)
}

export { socket }
export default socket
