import {configError, verificationFailed} from '../../core/errors';
import {callProvider, type FetchLike, type HttpResult, type ProviderHttp} from '../../core/http';
import {header} from '../../core/request';
import type {IncomingRequest} from '../../core/types';
import {hmacSha256Hex, parseSignatureHeader, safeEqual, withinTolerance} from '../../core/webhooks';
import {FINTOC_API, type FintocErrorResponse} from './api';

export interface FintocConfig {
    /** Transporte HTTP propio. Si falta, se usa el `fetch` global, resuelto en cada llamada. Ver `FetchLike`. */
    fetch?: FetchLike;
    /** Secret key (`sk_test_...` o `sk_live_...`). Va tal cual en el header `Authorization`. */
    secretKey: string;
    /** Secreto del webhook endpoint. Cada endpoint registrado tiene el suyo. */
    webhookSecret?: string;
    /** Header `Fintoc-Version`, por ejemplo `2026-02-01`. Si falta, Fintoc usa la versión de la cuenta. */
    apiVersion?: string;
    /** Tolerancia para el `t` de la firma, en segundos. Default 300 (el mínimo recomendado por Fintoc). */
    signatureToleranceSeconds?: number;
}

/** Una secret key para todos los productos de Fintoc: host, errores y verificación de webhooks. */
export class FintocCore implements ProviderHttp {
    readonly label = 'Fintoc';

    get fetch(): FetchLike | undefined {
        return this.config.fetch;
    }

    constructor(readonly config: FintocConfig) {
        if (!config.secretKey?.trim()) throw configError(this.label, 'falta secretKey');
    }

    url(path: string): string {
        return `${FINTOC_API.baseUrl}${path}`;
    }

    headers(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: this.config.secretKey,
            ...(this.config.apiVersion ? {'Fintoc-Version': this.config.apiVersion} : {}),
        };
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as FintocErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        const error = data?.error;
        const message = error?.message ? (error.param ? `${error.message} (${error.param})` : error.message) : undefined;
        return {code: error?.code ?? error?.type, message};
    }

    request<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: this.headers(),
            ...(body !== undefined ? {body: JSON.stringify(body), rawBody: body} : {}),
        });
    }

    /**
     * `Fintoc-Signature: t=<segundos>,v1=<hex>`; `v1` es HMAC-SHA256 en hex de `<t>.<cuerpo crudo>`
     * con el secreto del webhook endpoint.
     */
    verifyNotification(request: IncomingRequest): void {
        const secret = this.config.webhookSecret;
        if (!secret) throw configError(this.label, 'falta webhookSecret para verificar notificaciones');
        const signature = parseSignatureHeader(header(request, FINTOC_API.signatureHeader));
        if (!signature.t || !signature.v1) throw verificationFailed(this.label, `falta ${FINTOC_API.signatureHeader}`);
        if (!withinTolerance(signature.t, this.config.signatureToleranceSeconds ?? 300)) {
            throw verificationFailed(this.label, 'la firma expiró');
        }
        const expected = hmacSha256Hex(secret, `${signature.t}.${request.body ?? ''}`);
        if (!safeEqual(expected, signature.v1.toLowerCase())) throw verificationFailed(this.label, 'la firma no coincide');
    }
}
