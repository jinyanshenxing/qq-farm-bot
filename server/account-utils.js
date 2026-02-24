/**
 * account-utils - 提供对 Account 列表的脱敏工具
 */

function maskUin(uin) {
    if (!uin) return '';
    // 保证为字符串
    const s = String(uin);
    if (s.startsWith('wx_')) return '微信用户';
    if (s.length <= 4) return '****';
    if (s.length <= 6) return s.slice(0, 1) + '***' + s.slice(-1);
    return s.slice(0, 3) + '****' + s.slice(-2);
}

function maskNickname(nick) {
    if (!nick) return '隐藏用户';
    const s = String(nick);
    return s.charAt(0) + '***';
}

/**
 * 为匿名/未鉴权的客户端创建脱敏的 accounts 列表
 * 保留 `uin` 字段（用于内部 key），但对展示字段做脱敏处理
 */
function maskAccountsPublic(accounts = []) {
    return (accounts || []).map(a => {
        const isWx = a.platform === 'wx' || (a.uin && String(a.uin).startsWith('wx_'));
        return {
            ...a,
            nickname: maskNickname(a.nickname),
            displayUin: isWx ? '微信用户' : maskUin(a.uin),
            // 对于非拥有者默认标记为非拥有（前端会按 isOwn 判断是否可操控）
            isOwn: false,
            avatar: isWx ? 'https://q1.qlogo.cn/g?b=qq&nk=0&s=100' : `https://q1.qlogo.cn/g?b=qq&nk=${a.uin}&s=100`,
        };
    });
}

module.exports = { maskAccountsPublic, maskUin, maskNickname };
