/**
 * @copyright Copyright 2021 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

export default class HttpResponseError extends Error {
  /** Constructs an HttpResponseError.
   *
   * @param {!module:node-fetch.Response} res Error response.
   */
  constructor(res) {
    super(`${res.url}: ${res.status} ${res.statusText}`);
    this.headers = res.headers;
    this.status = res.status;
    this.statusText = res.statusText;
    this.url = res.url;
  }
}
Object.defineProperty(
  HttpResponseError.prototype,
  'name',
  {
    configurable: true,
    enumerable: false,
    value: 'HttpResponseError',
    writable: true,
  },
);
