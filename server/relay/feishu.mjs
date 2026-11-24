import { createHash } from 'node:crypto';

const ROOT = 'https://open.feishu.cn/open-apis';
const AUTH = ROOT + '/auth/v3/tenant_access_token/internal';
const MESSAGES = ROOT + '/im/v1/messages?receive_id_type=chat_id';

export function makeFeishuSender({ appId, appSecret, chatId }, request = fetch) {
  if (!appId?.trim() || !appSecret?.trim()) throw new Error('Feishu enabled but application credentials are missing');
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '')) throw new Error('FEISHU_CHAT_ID must be a Feishu chat ID');
  let credential;

  async function post(url, json, accessToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    const response = await request(url, {
      method: 'POST', headers, body: JSON.stringify(json), redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('Feishu HTTP ' + response.status);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return response.json();
  }

  async function getAccessToken() {
    if (credential?.until > Date.now()) return credential.token;
    const auth = await post(AUTH, { app_id: appId.trim(), app_secret: appSecret.trim() });
    if (auth?.code !== 0 || typeof auth.tenant_access_token !== 'string' || !auth.tenant_access_token) {
      const error = new Error('Feishu application authorization failed');
      error.retryable = false;
      throw error;
    }
    credential = { token: auth.tenant_access_token, until: Date.now() + (Number(auth.expire) - 60) * 1000 };
    return credential.token;
  }

  return {
    target: chatId,
    async send(id, transcript) {
      const uuid = createHash('sha256').update(`${chatId}\0${id}`).digest('hex').slice(0, 32);
      const body = { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: transcript }), uuid };
      if (Buffer.byteLength(JSON.stringify(body)) > 150 * 1024) {
        const error = new Error('Feishu text message exceeds the size limit');
        error.retryable = false;
        throw error;
      }
      const result = await post(MESSAGES, body, await getAccessToken());
      if (result?.code !== 0 || typeof result.data?.message_id !== 'string') {
        const error = new Error('Feishu message not acknowledged');
        error.retryable = false;
        throw error;
      }
      return result.data.message_id;
    },
  };
}
