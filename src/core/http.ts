import {providerError} from './errors';
import type {ProviderRawRequest} from './types';

/** Firma estándar de `fetch`. Sirve para inyectar un transporte propio. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderHttp {
    /** Transporte propio; si falta, `globalThis.fetch` en cada llamada. */
    readonly fetch?: FetchLike;

    /** Nombre para los mensajes de error. */
    label: string;

    /** Lee el cuerpo de error de esta pasarela. */
    parseError(status: number, body: unknown): { code?: string; message?: string };

    timeoutMs?: number;
}

export interface HttpCall {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    /** Lo que se registra en rawRequest. Sin secretos. */
    rawBody?: unknown;
}

export interface HttpResult<T> {
    status: number;
    data: T;
    rawRequest: ProviderRawRequest;
    rawResponse: unknown;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Una sola forma de hablar con las pasarelas: timeout, cuerpo leído antes de mirar
 * `ok` (JSON o texto), y errores convertidos a PROVIDER_ERROR con el HTTP original.
 */
export async function callProvider<T>(http: ProviderHttp, call: HttpCall): Promise<HttpResult<T>> {
    const rawRequest: ProviderRawRequest = {
        method: call.method,
        url: call.url,
        ...(call.rawBody !== undefined ? {body: call.rawBody} : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), http.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
        const transport: FetchLike = http.fetch ?? ((input, init) => globalThis.fetch(input, init));
        response = await transport(call.url, {
            method: call.method,
            headers: call.headers,
            body: call.body,
            signal: controller.signal,
        });
    } catch (error) {
        clearTimeout(timer);
        const aborted = error instanceof Error && error.name === 'AbortError';
        throw providerError(http.label, aborted ? 'timeout' : `sin respuesta (${describe(error)})`, {
            retryable: true,
        });
    }
    clearTimeout(timer);

    const text = await response.text();
    let body: unknown = text;
    if (text) {
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            body = text;
        }
    }

    if (!response.ok) {
        const parsed = http.parseError(response.status, body);
        throw providerError(http.label, parsed.message || response.statusText || `HTTP ${response.status}`, {
            httpStatus: response.status,
            providerCode: parsed.code,
            retryable: response.status >= 500 || response.status === 429,
            raw: body,
        });
    }

    return {status: response.status, data: body as T, rawRequest, rawResponse: body};
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
