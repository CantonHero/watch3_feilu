const endpoints = new Map([
  ['cn', 'https://api.minimax.cn/v1/speech_to_text'],
  ['global', 'https://api.minimax.io/v1/speech_to_text'],
]);

function rejected(status) {
  const error = new Error('MiniMax ASR HTTP ' + status);
  if ([400, 413, 415, 422].includes(status)) error.code = 'invalid_audio';
  if ([401, 402, 403, 404].includes(status)) error.retryable = false;
  return error;
}

export async function makeMiniMaxTranscriber({ apiKey, region = 'cn' }, request = fetch) {
  const key = apiKey?.trim();
  if (!key) throw new Error('MiniMax mode requires server-side MINIMAX_API_KEY');
  const url = endpoints.get(region);
  if (!url) throw new Error('MINIMAX_REGION must be cn or global');

  const { Converter } = await import('opencc-js');
  const simplify = Converter({ from: 't', to: 'cn' });
  return async audio => {
    const form = new FormData();
    form.set('model', 'asr-1.0');
    form.set('file', new Blob([audio], { type: 'audio/mp4' }), 'recording.m4a');
    form.set('response_format', 'json');
    form.set('stream', 'false');
    const response = await request(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, language: 'zh' },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw rejected(response.status);
    }
    const payload = await response.json();
    if (payload?.error || (payload?.base_resp && payload.base_resp.status_code !== 0)
        || typeof payload?.text !== 'string') {
      throw new Error('MiniMax ASR did not return a successful transcript');
    }
    return simplify(payload.text).trim();
  };
}
