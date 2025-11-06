import type { Context } from '@netlify/edge-functions'

import type { RequestData } from './types'

export const buildNextRequest = (request: Request): RequestData => {
  const { url, method, body, headers } = request

  // we don't really use it but Next.js expects a signal
  const abortController = new AbortController()

  return {
    headers: Object.fromEntries(headers.entries()),
    method,
    // nextConfig?: {
    //     basePath?: string;
    //     i18n?: I18NConfig | null;
    //     trailingSlash?: boolean;
    //     experimental?: Pick<ExperimentalConfig, 'cacheLife' | 'authInterrupts' | 'clientParamParsingOrigins'>;
    // };
    // page?: {
    //     name?: string;
    //     params?: {
    //         [key: string]: string | string[] | undefined;
    //     };
    // };
    url,
    body: body ?? undefined,
    signal: abortController.signal,
    /** passed in when running in edge runtime sandbox */
    // waitUntil?: (promise: Promise<any>) => void;
  }
}
