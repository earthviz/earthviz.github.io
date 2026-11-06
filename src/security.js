const JSON_TYPE = /(?:^|\/|\+)json(?:;|$)/i;

export function privacyFetch(input, init = {}) {
  return fetch(input, {
    ...init,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
}

async function readLimitedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response exceeds ${maximumBytes} bytes`);
  }

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) throw new Error(`Response exceeds ${maximumBytes} bytes`);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new Error(`Response exceeds ${maximumBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJson(response, maximumBytes = 256_000) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!JSON_TYPE.test(contentType)) throw new Error('Unexpected response type');
  const bytes = await readLimitedBody(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Invalid JSON response');
  }
}

export async function readArrayBuffer(response, maximumBytes) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readLimitedBody(response, maximumBytes);
  return bytes.buffer;
}

export function normalizePlace(value) {
  const name = typeof value?.name === 'string' ? value.name.trim().slice(0, 240) : '';
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { name, lat, lng };
}
