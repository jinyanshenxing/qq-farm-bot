/**
 * QR 扫码登录服务 - 为 Web 端提供二维码 Base64
 *
 * 复用原始 qqQrLogin.js 的 HTTP API，但将终端打印替换为 Base64 输出。
 */

const axios = require('axios');
const QRCode = require('qrcode');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';
const FARM_APP_ID = '1112386029';

function getHeaders() {
    return {
        qua: QUA,
        host: 'q.qq.com',
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': CHROME_UA,
    };
}

/**
 * 请求 QQ 登录二维码
 * @returns {{ loginCode: string, url: string }}
 */
async function requestQrLogin() {
    const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
        headers: getHeaders(),
    });
    const { code, data } = response.data || {};
    if (+code !== 0 || !data || !data.code) {
        throw new Error('获取QQ扫码登录码失败');
    }
    return {
        loginCode: data.code,
        url: `https://h5.qzone.qq.com/qqq/code/${data.code}?_proxy=1&from=ide`,
    };
}

/**
 * 查询扫码状态
 * @returns {{ status: 'OK'|'Wait'|'Used'|'Error', ticket?: string }}
 */
async function queryScanStatus(loginCode) {
    const response = await axios.get(
        `https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${encodeURIComponent(loginCode)}`,
        { headers: getHeaders() }
    );
    if (response.status !== 200) return { status: 'Error' };
    const { code, data } = response.data || {};
    if (+code === 0) {
        if (+data?.ok !== 1) return { status: 'Wait' };
        return { status: 'OK', ticket: data.ticket || '' };
    }
    if (+code === -10003) return { status: 'Used' };
    return { status: 'Error' };
}

/**
 * 用 ticket 换取登录 code
 */
async function getAuthCode(ticket) {
    const response = await axios.post(
        'https://q.qq.com/ide/login',
        { appid: FARM_APP_ID, ticket },
        { headers: getHeaders() }
    );
    if (response.status !== 200 || !response.data || !response.data.code) {
        throw new Error('获取农场登录 code 失败');
    }
    return response.data.code;
}

/**
 * 将二维码 URL 转为 Base64 PNG
 * @param {string} url - 二维码包含的链接
 * @returns {string} data:image/png;base64,...
 */
async function getQrCodeBase64(url) {
    const dataUrl = await QRCode.toDataURL(url, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    });
    return dataUrl; // data:image/png;base64,...
}

module.exports = {
    requestQrLogin,
    queryScanStatus,
    getAuthCode,
    getQrCodeBase64,
};
