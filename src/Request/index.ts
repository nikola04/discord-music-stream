import { IncomingMessage } from 'node:http';
import { RequestOptions, request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

interface RequestOpts extends RequestOptions {
    body?: string;
    method?: 'GET' | 'POST' | 'HEAD';
    cookies?: boolean;
    cookieJar?: { [key: string]: string };
}

/**
 * Main module which play-dl uses to make a request to stream url.
 * @param url URL to make https request to
 * @param options Request options for https request
 * @returns IncomingMessage from the request
 */
export function request_stream(req_url: string, options: RequestOpts = { method: 'GET' }): Promise<IncomingMessage> {
    return new Promise(async (resolve, reject) => {
        let res = await https_getter(req_url, options).catch((err: Error) => err);
        if (res instanceof Error) {
            reject(res);
            return;
        }
        if (Number(res.statusCode) >= 300 && Number(res.statusCode) < 400) {
            res = await request_stream(res.headers.location as string, options);
        }
        resolve(res);
    });
}
/**
 * Makes a request and follows redirects if necessary
 * @param req_url URL to make https request to
 * @param options Request options for https request
 * @returns A promise with the final response object
 */
function internalRequest(req_url: string, options: RequestOpts = { method: 'GET' }): Promise<IncomingMessage> {
    return new Promise(async (resolve, reject) => {
        let res = await https_getter(req_url, options).catch((err: Error) => err);
        if (res instanceof Error) {
            reject(res);
            return;
        }
        if (Number(res.statusCode) >= 300 && Number(res.statusCode) < 400) {
            res = await internalRequest(res.headers.location as string, options);
        } else if (Number(res.statusCode) > 400) {
            reject(new Error(`Got ${res.statusCode} from the request`));
            return;
        }
        resolve(res);
    });
}
/**
 * Main module which play-dl uses to make a request
 * @param url URL to make https request to
 * @param options Request options for https request
 * @returns body of that request
 */


export function request_resolve_redirect(url: string): Promise<string> {
    return new Promise(async (resolve, reject) => {
        let res = await https_getter(url, { method: 'HEAD' }).catch((err: Error) => err);
        if (res instanceof Error) {
            reject(res);
            return;
        }
        const statusCode = Number(res.statusCode);
        if (statusCode < 300) {
            resolve(url);
        } else if (statusCode < 400) {
            const resolved = await request_resolve_redirect(res.headers.location as string).catch((err) => err);
            if (resolved instanceof Error) {
                reject(resolved);
                return;
            }

            resolve(resolved);
        } else {
            reject(new Error(`${res.statusCode}: ${res.statusMessage}, ${url}`));
        }
    });
}

export function request_content_length(url: string): Promise<number> {
    return new Promise(async (resolve, reject) => {
        let res = await https_getter(url, { method: 'HEAD' }).catch((err: Error) => err);
        if (res instanceof Error) {
            reject(res);
            return;
        }
        const statusCode = Number(res.statusCode);
        if (statusCode < 300) {
            resolve(Number(res.headers['content-length']));
        } else if (statusCode < 400) {
            const newURL = await request_resolve_redirect(res.headers.location as string).catch((err) => err);
            if (newURL instanceof Error) {
                reject(newURL);
                return;
            }

            const res2 = await request_content_length(newURL).catch((err) => err);
            if (res2 instanceof Error) {
                reject(res2);
                return;
            }

            resolve(res2);
        } else {
            reject(
                new Error(`Failed to get content length with error: ${res.statusCode}, ${res.statusMessage}, ${url}`)
            );
        }
    });
}

/**
 * Main module that play-dl uses for making a https request
 * @param req_url URL to make https request to
 * @param options Request options for https request
 * @returns Incoming Message from the https request
 */
function https_getter(req_url: string, options: RequestOpts = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const s = new URL(req_url);
        options.method ??= 'GET';
        const req_options: RequestOptions = {
            host: s.hostname,
            path: s.pathname + s.search,
            headers: options.headers ?? {},
            method: options.method
        };

        const req = httpsRequest(req_options, resolve);
        req.on('error', (err) => {
            reject(err);
        });
        if (options.method === 'POST') req.write(options.body);
        req.end();
    });
}
