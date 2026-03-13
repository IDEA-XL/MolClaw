import type { Agent } from 'https';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'proxy-agent';
import { ProxyAgent as UndiciProxyAgent, setGlobalDispatcher } from 'undici';

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

let cachedSocketAgent: Agent | undefined;
let cachedFetchDispatcher: UndiciProxyAgent | undefined;
let globalFetchProxyConfigured = false;

function firstProxyEnv(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function getConfiguredProxyUrl(): string | undefined {
  return firstProxyEnv();
}

export function maskProxyUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function createSocketProxyAgent(): Agent | undefined {
  if (cachedSocketAgent) {
    return cachedSocketAgent;
  }

  const proxyUrl = firstProxyEnv();
  if (!proxyUrl) {
    return undefined;
  }

  try {
    const protocol = new URL(proxyUrl).protocol;
    if (protocol === 'http:' || protocol === 'https:') {
      cachedSocketAgent = new HttpsProxyAgent(proxyUrl) as Agent;
      return cachedSocketAgent;
    }
  } catch {
    // Fall back to ProxyAgent for non-URL values or unsupported schemes.
  }

  cachedSocketAgent = new ProxyAgent() as Agent;
  return cachedSocketAgent;
}

export function createFetchProxyDispatcher(): UndiciProxyAgent | undefined {
  if (cachedFetchDispatcher) {
    return cachedFetchDispatcher;
  }

  const proxyUrl = firstProxyEnv();
  if (!proxyUrl) {
    return undefined;
  }

  try {
    cachedFetchDispatcher = new UndiciProxyAgent(proxyUrl);
    return cachedFetchDispatcher;
  } catch {
    return undefined;
  }
}

export function configureGlobalFetchProxy(): void {
  if (globalFetchProxyConfigured) {
    return;
  }

  const dispatcher = createFetchProxyDispatcher();
  if (!dispatcher) {
    return;
  }

  setGlobalDispatcher(dispatcher);
  globalFetchProxyConfigured = true;
}
