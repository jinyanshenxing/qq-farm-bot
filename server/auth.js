/**
 * 简单的 JWT 认证中间件
 */

const crypto = require('crypto');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'qq-farm-bot-jwt-secret-key-2026';

// ============ 简易 JWT 实现 (无外部依赖) ============

function base64url(str) {
    return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString();
}

function signToken(payload, expiresInSec = 86400 * 7) {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    payload.exp = Math.floor(Date.now() / 1000) + expiresInSec;
    payload.iat = Math.floor(Date.now() / 1000);
    const body = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [header, body, sig] = parts;
        const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64')
            .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        if (sig !== expectedSig) return null;
        const payload = JSON.parse(base64urlDecode(body));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// ============ Express 中间件 ============

/** 验证 JWT Token */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ ok: false, error: '未登录' });
    }
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (!payload) {
        return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' });
    }
    req.user = payload; // { id, username, role, allowedUins }
    next();
}

/** 仅管理员可访问 */
function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ ok: false, error: '权限不足' });
    }
    next();
}

/** 检查用户是否有权访问指定 uin */
function canAccessUin(req, res, next) {
    const { uin } = req.params;
    if (req.user.role === 'admin') return next();
    // 从数据库获取最新的 allowed_uins（JWT 中的可能过时）
    const adminUser = db.getAdminUserById(req.user.id);
    const allowed = (adminUser?.allowed_uins || '').split(',').map(s => s.trim()).filter(Boolean);
    // 如果没有任何绑定账号，普通用户不应有额外权限
    const hasAllowed = (targetUin) => {
        if (allowed.includes(targetUin)) return true;
        // 兼容可能存在的 wx_ 前缀差异
        if (targetUin && targetUin.startsWith('wx_')) {
            const stripped = targetUin.slice(3);
            if (allowed.includes(stripped)) return true;
        } else if (targetUin) {
            if (allowed.includes('wx_' + targetUin)) return true;
        }
        return false;
    };

    if (!hasAllowed(uin)) {
        return res.status(403).json({ ok: false, error: '无权访问该账号' });
    }
    next();
}

module.exports = {
    signToken,
    verifyToken,
    hashPassword,
    authMiddleware,
    adminOnly,
    canAccessUin,
};
