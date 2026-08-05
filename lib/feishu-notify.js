/**
 * 飞书通知模块 —— 供主服务 index.js 和 scripts/price-alert.js 复用
 * 自动读取 ~/.hermes/config.yaml 的 feishu 凭证 + channel_directory.json 的 chat_id
 * 无配置时 sendFeishu 静默返回 false（调用方降级为仅 macOS 通知）
 */
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const HERMES_DIR = path.join(homedir(), '.hermes');

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(HERMES_DIR, 'config.yaml'), 'utf8');
    const appIdMatch = raw.match(/app_id:\s*(\S+)/);
    const appSecretMatch = raw.match(/app_secret:\s*(\S+)/);
    if (!appIdMatch || !appSecretMatch) return null;

    let chatId = null;
    try {
      const chan = JSON.parse(fs.readFileSync(path.join(HERMES_DIR, 'channel_directory.json'), 'utf8'));
      const feishuDms = (chan.platforms?.feishu || []).filter(c => c.type === 'dm');
      if (feishuDms.length) chatId = feishuDms[0].id.split(':')[0];
    } catch (_) {}

    return { appId: appIdMatch[1], appSecret: appSecretMatch[1], chatId };
  } catch (_) {
    return null;
  }
}

const config = loadConfig();
let token = null;
let tokenExpiry = 0;

function postJson(url, payload, headers = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => { clearTimeout(timer); resolve(data); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

async function getToken() {
  if (!config) return null;
  if (token && Date.now() < tokenExpiry) return token;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: config.appId, app_secret: config.appSecret,
      });
      if (r.code === 0 && r.tenant_access_token) {
        token = r.tenant_access_token;
        tokenExpiry = Date.now() + (r.expire - 60) * 1000;
        return token;
      }
    } catch (_) {}
    await new Promise(res => setTimeout(res, 1200));
  }
  return null;
}

/**
 * 发送飞书文本消息
 * @param {string} text 消息内容
 * @returns {Promise<boolean>} 是否发送成功
 */
export async function sendFeishu(text) {
  if (!config || !config.chatId) return false;
  const t = await getToken();
  if (!t) return false;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await postJson(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        { receive_id: config.chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        { Authorization: `Bearer ${t}` }
      );
      if (r.code === 0) return true;
    } catch (_) {}
    await new Promise(res => setTimeout(res, 1200));
  }
  return false;
}

/** 是否已配置飞书（供调用方决定是否打印启用信息） */
export function isFeishuEnabled() {
  return Boolean(config && config.chatId);
}

/** 获取目标 chat_id（调试用，截断展示） */
export function getFeishuChatId() {
  return config?.chatId || null;
}
