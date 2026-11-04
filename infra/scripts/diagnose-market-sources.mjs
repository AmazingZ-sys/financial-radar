import https from 'node:https';
import { performance } from 'node:perf_hooks';

// Fixed public, credential-free endpoints only. Never print network error text,
// response bodies/headers, IP addresses, or process environment configuration.
const probes = [
  {
    name: 'gold-json',
    url: 'https://api.gold-api.com/price/XAU',
    accept: 'application/json',
  },
  {
    name: 'eia-zip',
    url: 'https://www.eia.gov/opendata/bulk/PET.zip',
    accept: 'application/zip',
  },
  {
    name: 'eia-any',
    url: 'https://www.eia.gov/opendata/bulk/PET.zip',
    accept: '*/*',
  },
];
const timeoutMs = 12_000;
const safeCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEOUT',
  'ESERVFAIL',
  'ENODATA',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'ABORT_ERR',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function codesFor(error) {
  const codes = new Set();
  const pending = [error];
  const seen = new Set();
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && safeCodes.has(current.code)) codes.add(current.code);
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
  }
  return codes.size ? [...codes] : ['NETWORK_ERROR'];
}

async function probe(target) {
  const host = new URL(target.url).hostname;
  const started = performance.now();
  const emit = (stage, status, extra = {}) =>
    process.stdout.write(
      JSON.stringify({
        probe: target.name,
        host,
        stage,
        status,
        durationMs: Math.round(performance.now() - started),
        ...extra,
      }) + '\n',
    );
  await new Promise((resolve) => {
    let finished = false;
    let stage = 'dns';
    let timer;
    let request;
    const finish = (status, extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      emit(stage, status, extra);
      request?.destroy();
      resolve();
    };
    try {
      request = https.request(
        target.url,
        {
          method: 'GET',
          agent: false,
          headers: {
            Accept: target.accept,
            'User-Agent': 'FinancialRadar/1.0 (private research)',
          },
        },
        (response) => {
          stage = 'http';
          finish('response', { statusCode: response.statusCode });
          // Stop before downloading the EIA archive or any provider body.
          response.destroy();
        },
      );
      request.on('socket', (socket) => {
        socket.once('lookup', (error) => {
          if (finished) return;
          if (error) {
            finish('error', { causeCodes: codesFor(error) });
            return;
          }
          emit('dns', 'ok');
          stage = 'tcp';
        });
        socket.once('connect', () => {
          if (finished) return;
          emit('tcp', 'ok');
          stage = 'tls';
        });
        socket.once('secureConnect', () => {
          if (finished) return;
          emit('tls', 'ok');
          stage = 'http';
        });
      });
      request.once('error', (error) => finish('error', { causeCodes: codesFor(error) }));
      timer = setTimeout(() => finish('timeout', { causeCodes: ['PROBE_TIMEOUT'] }), timeoutMs);
      request.end();
    } catch (error) {
      finish('error', { causeCodes: codesFor(error) });
    }
  });
}

for (const target of probes) await probe(target);
