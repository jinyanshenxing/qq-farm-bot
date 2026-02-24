#!/usr/bin/env node
/**
 * 快速测试权限与脱敏功能
 */
const axios = require('axios');

const API = 'http://localhost:3000/api';

async function test() {
  console.log('=== 权限与脱敏测试 ===\n');

  // 1. 管理员登录
  console.log('1. 管理员登录...');
  let adminToken;
  try {
    const res = await axios.post(`${API}/auth/login`, { username: 'admin', password: 'admin123' });
    adminToken = res.data.data.token;
    console.log('   ✓ 管理员登录成功\n');
  } catch (e) {
    console.log('   ✗ 管理员登录失败:', e.response?.data?.error || e.message, '\n');
    return;
  }

  // 2. 获取管理员用户列表
  console.log('2. 获取平台用户列表 (GET /admin/users)...');
  try {
    const res = await axios.get(`${API}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('   ✓ 平台用户列表:');
    (res.data.data || []).forEach(u => {
      console.log(`     - ID:${u.id} 用户名:${u.username} 角色:${u.role} allowed_uins:${u.allowed_uins || '(空)'}`);
    });
    console.log();
  } catch (e) {
    console.log('   ✗ 获取失败:', e.response?.data?.error || e.message, '\n');
  }

  // 3. 获取账号列表（管理员视角）
  console.log('3. 获取账号列表 - 管理员视角 (GET /accounts)...');
  try {
    const res = await axios.get(`${API}/accounts`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const accounts = res.data.data || [];
    console.log(`   ✓ 共 ${accounts.length} 个账号:`);
    accounts.forEach(a => {
      console.log(`     - uin:${a.uin} displayUin:${a.displayUin} nickname:${a.nickname} isOwn:${a.isOwn} platform:${a.platform}`);
    });
    console.log();
  } catch (e) {
    console.log('   ✗ 获取失败:', e.response?.data?.error || e.message, '\n');
  }

  // 4. 注册一个测试用户
  const testUser = 'testuser_' + Date.now();
  console.log(`4. 注册测试用户: ${testUser}...`);
  let userToken;
  try {
    const res = await axios.post(`${API}/auth/register`, { username: testUser, password: 'test1234' });
    userToken = res.data.data.token;
    console.log('   ✓ 注册成功\n');
  } catch (e) {
    console.log('   ✗ 注册失败:', e.response?.data?.error || e.message, '\n');
    return;
  }

  // 5. 普通用户获取账号列表（应该全部脱敏且 isOwn=false）
  console.log('5. 获取账号列表 - 普通用户视角 (无绑定账号)...');
  try {
    const res = await axios.get(`${API}/accounts`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    const accounts = res.data.data || [];
    console.log(`   ✓ 共 ${accounts.length} 个账号:`);
    accounts.forEach(a => {
      console.log(`     - uin:${a.uin} displayUin:${a.displayUin} nickname:${a.nickname} isOwn:${a.isOwn}`);
    });
    const allMasked = accounts.every(a => !a.isOwn);
    console.log(`   ${allMasked ? '✓' : '✗'} 所有账号 isOwn=false: ${allMasked}\n`);
  } catch (e) {
    console.log('   ✗ 获取失败:', e.response?.data?.error || e.message, '\n');
  }

  // 6. 普通用户尝试访问不属于自己的账号（应该被拒绝）
  console.log('6. 普通用户访问未授权账号 (应返回 403)...');
  try {
    await axios.get(`${API}/accounts/123456789/snapshot`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    console.log('   ✗ 未返回 403，权限检查可能有问题\n');
  } catch (e) {
    if (e.response?.status === 403) {
      console.log('   ✓ 正确返回 403:', e.response.data.error, '\n');
    } else {
      console.log('   ? 返回状态:', e.response?.status, e.response?.data?.error || e.message, '\n');
    }
  }

  console.log('=== 测试完成 ===');
}

test().catch(e => {
  console.error('测试出错:', e.message);
  process.exit(1);
});
