import { vi } from 'vitest';
import type { IncomingRequest } from '../../src';

export interface FakeResponse {
    status?: number;
    body?: unknown;
    /** Cuerpo crudo no JSON (por ejemplo HTML de un 502). */
    text?: string;
}

export interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    json(): unknown;
}

/**
 * Reemplaza `fetch` por una secuencia de respuestas. Devuelve las llamadas hechas.
 * Cada respuesta se consume en orden; si faltan, la llamada falla.
 */
export function mockFetch(responses: FakeResponse[]): RecordedCall[] {
    const calls: RecordedCall[] = [];
    const queue = [...responses];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            const call: RecordedCall = {
                url,
                method: init.method ?? 'GET',
                headers: (init.headers as Record<string, string>) ?? {},
                body: typeof init.body === 'string' ? init.body : undefined,
                json: () => (typeof init.body === 'string' ? JSON.parse(init.body) : undefined),
            };
            calls.push(call);
            const next = queue.shift();
            if (!next) throw new Error(`fetch inesperado: ${call.method} ${url}`);
            const status = next.status ?? 200;
            const text = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
            return {
                ok: status >= 200 && status < 300,
                status,
                statusText: status === 200 ? 'OK' : `HTTP ${status}`,
                text: async () => text,
            };
        }),
    );
    return calls;
}

export function failingFetch(error: Error): void {
    vi.stubGlobal('fetch', vi.fn(async () => { throw error; }));
}

export function getRequest(url: string, headers: Record<string, string> = {}): IncomingRequest {
    return { method: 'GET', url, headers };
}

export function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}): IncomingRequest {
    return {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
    };
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}): IncomingRequest {
    return {
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    };
}
