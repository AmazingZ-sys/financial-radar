import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    // Only global-unicast IPv6; reject mapped IPv4, unique/link/site-local and documentation.
    const value = address.toLowerCase();
    const second = Number.parseInt(value.split(':')[1] ?? '0', 16);
    return (
      /^[23][0-9a-f]{3}:/.test(value) &&
      !value.startsWith('2001:db8:') &&
      !(value.startsWith('2001:') && second < 0x200) &&
      !(value.startsWith('3fff:') && second <= 0xfff) &&
      !value.startsWith('2002:')
    );
  }
  return false;
}

async function resolvePublic(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('外部地址必须为公开 HTTPS 地址，不得含凭据或片段');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
    throw new Error('不允许访问本机或私有网络');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('外部地址解析超时')), 5000);
        lookup(hostname, { all: true })
          .then(resolve, () => reject(new Error('外部地址无法解析')))
          .finally(() => clearTimeout(timer));
      });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new Error('外部地址解析到私有或保留网络');
  return { url, addresses };
}

export async function assertPublicHttpsUrl(url: string): Promise<void> {
  await resolvePublic(url);
}

/** Bounded, pinned-DNS HTTPS transport for administrator-configured integrations. */
export async function fetchPublicHttps(value: string, init: RequestInit = {}): Promise<Response> {
  const { url, addresses } = await resolvePublic(value);
  const address = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  if ('host' in headers) throw new Error('不得覆盖外部请求 Host');
  if (init.body != null && typeof init.body !== 'string') throw new Error('不支持的请求正文');
  const signal = init.signal ?? AbortSignal.timeout(20000);
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        signal,
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, addresses);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const code = response.statusCode ?? 502;
        if (code >= 300 && code < 400 && code !== 304) {
          response.destroy();
          reject(new Error('外部接口重定向已拒绝'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            response.destroy();
            reject(new Error('外部响应超过 2MB 限制'));
          } else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('外部响应读取失败')));
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, entry] of Object.entries(response.headers))
            if (entry !== undefined)
              responseHeaders.set(key, Array.isArray(entry) ? entry.join(', ') : entry);
          const body = [204, 205, 304].includes(code) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status: code, headers: responseHeaders }));
        });
      },
    );
    req.on('error', () => reject(new Error('外部 HTTPS 请求失败或超时')));
    req.setTimeout(60000, () => req.destroy(new Error('外部请求超时')));
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}
