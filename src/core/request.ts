import type {IncomingRequest} from './types';

/** Header sin distinguir mayúsculas. */
export function header(request: IncomingRequest, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(request.headers)) {
        if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
}

export function queryParams(request: IncomingRequest): Record<string, string> {
    const params: Record<string, string> = {};
    try {
        const url = new URL(request.url, 'http://localhost');
        url.searchParams.forEach((value, key) => {
            params[key] = value;
        });
    } catch {
        // URL inválida: sin query
    }
    return params;
}

/** Cuerpo como objeto: JSON o form-urlencoded según Content-Type. Vacío si no aplica. */
export function bodyParams(request: IncomingRequest): Record<string, unknown> {
    const body = request.body?.trim();
    if (!body) return {};
    const contentType = header(request, 'content-type') ?? '';
    if (contentType.includes('application/json') || body.startsWith('{')) {
        try {
            const parsed = JSON.parse(body) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
        } catch {
            return {};
        }
    }
    const params: Record<string, unknown> = {};
    new URLSearchParams(body).forEach((value, key) => {
        params[key] = value;
    });
    return params;
}

/** Query y cuerpo juntos, solo valores string. El cuerpo gana. */
export function requestFields(request: IncomingRequest): Record<string, string> {
    const fields: Record<string, string> = {...queryParams(request)};
    for (const [key, value] of Object.entries(bodyParams(request))) {
        if (typeof value === 'string') fields[key] = value;
    }
    return fields;
}

/** Convierte un `Request` estándar (fetch, Hono `c.req.raw`, Next) en IncomingRequest. */
export async function fromWebRequest(request: Request): Promise<IncomingRequest> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        headers[key] = value;
    });
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    return {method: request.method, url: request.url, headers, body};
}
