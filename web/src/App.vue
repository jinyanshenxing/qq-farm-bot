<template>
  <router-view />
</template>

<script setup>
import { useThemeStore } from './stores/theme.js'
// 初始化主题 store，确保 applyTheme 在 mount 前运行
useThemeStore()
</script>

<style>
/* ============ CSS 变量：暗色主题 (默认) ============ */
:root,
html[data-theme="dark"] {
  --bg-base: #0d1117;
  --bg-surface: #161b22;
  --bg-hover: #1c2128;
  --bg-inset: #010409;
  --border: #21262d;
  --border-strong: #30363d;
  --text: #e6edf3;
  --text-secondary: #c9d1d9;
  --text-muted: #8b949e;
  --text-faint: #484f58;
  --accent: #58a6ff;
  --accent-bg: #1f6feb33;
  --color-success: #3fb950;
  --color-warning: #d29922;
  --color-danger: #f85149;
  --shadow: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
  --login-gradient: linear-gradient(135deg, #0d1117 0%, #161b22 50%, #0d1117 100%);
  --sidebar-bg: none;
  --sidebar-text: #e6edf3;
  --sidebar-text-muted: #8b949e;
  --sidebar-text-faint: #484f58;
  --sidebar-border: #21262d;
  --sidebar-hover: #21262d;
  --sidebar-active-bg: #1f6feb33;
}

/* ============ CSS 变量：日间主题 ============ */
html[data-theme="light"] {
  --bg-base: #f0f2f5;
  --bg-surface: #ffffff;
  --bg-hover: #f5f7fa;
  --bg-inset: #f0f2f5;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --text: #1e293b;
  --text-secondary: #334155;
  --text-muted: #64748b;
  --text-faint: #94a3b8;
  --accent: #4f7cff;
  --accent-bg: rgba(79,124,255,0.08);
  --color-success: #16a34a;
  --color-warning: #ca8a04;
  --color-danger: #dc2626;
  --shadow: 0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04);
  --login-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  --sidebar-bg: linear-gradient(180deg, #1e293b 0%, #334155 100%);
  --sidebar-text: #e2e8f0;
  --sidebar-text-muted: #94a3b8;
  --sidebar-text-faint: #64748b;
  --sidebar-border: rgba(255,255,255,0.08);
  --sidebar-hover: rgba(255,255,255,0.06);
  --sidebar-active-bg: rgba(79,124,255,0.18);

  /* Element Plus 组件覆盖 */
  --el-bg-color: #ffffff;
  --el-bg-color-overlay: #ffffff;
  --el-text-color-primary: #1e293b;
  --el-text-color-regular: #334155;
  --el-border-color: #e5e7eb;
  --el-border-color-light: #f0f0f0;
  --el-fill-color-blank: #ffffff;
  --el-fill-color-light: #f5f7fa;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg-base);
  color: var(--text-secondary);
  transition: background 0.3s, color 0.3s;
}
</style>
