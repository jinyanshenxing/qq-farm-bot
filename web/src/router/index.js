import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/LoginView.vue'),
    meta: { noAuth: true },
  },
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/DashboardView.vue'),
      },
      {
        path: 'account/:uin',
        name: 'AccountHome',
        component: () => import('../views/AccountHome.vue'),
        props: true,
      },
      {
        path: 'account/:uin/lands',
        name: 'AccountLands',
        component: () => import('../views/AccountLands.vue'),
        props: true,
      },
      {
        path: 'account/:uin/settings',
        name: 'AccountSettings',
        component: () => import('../views/AccountSettings.vue'),
        props: true,
      },
      {
        path: 'account/:uin/logs',
        name: 'AccountLogs',
        component: () => import('../views/AccountLogs.vue'),
        props: true,
      },
      {
        path: 'admin/users',
        name: 'AdminUsers',
        component: () => import('../views/AdminUsers.vue'),
        meta: { admin: true },
      },
    ],
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 路由守卫
router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.noAuth) return next()
  if (!token) return next('/login')
  if (to.meta.admin) {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    if (user.role !== 'admin') return next('/dashboard')
  }
  next()
})

export default router
