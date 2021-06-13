/*******************************************************************************
 * Api
 ******************************************************************************/

export interface RequestParams {
  port: number;
  path: string;
  hostname: string;
  protocol: string;
}

/**
 * Connection parameters for the `cardano-wallet` API.
 * These should be used to build the HTTP requests.
 */
export interface Api {
  /**
   * API base URL, including trailling slash.
   */
  baseUrl: string;

  /**
   * URL components which can be used with the HTTP client library of
   * your choice.
   */
  requestParams: RequestParams;
}

export class V2Api implements Api {
  /** URL of the API, including a trailing slash. */
  readonly baseUrl: string;
  /** URL components which can be used with the HTTP client library of
   * your choice. */
  readonly requestParams: RequestParams;

  constructor(port: number, tls: boolean) {
    const protocol = tls ? 'https:' : 'http:';
    const hostname = '127.0.0.1';
    const path = '/v2/';
    this.baseUrl = `${protocol}//${hostname}:${port}${path}`;
    this.requestParams = { port, path, hostname, protocol };
  }
}
