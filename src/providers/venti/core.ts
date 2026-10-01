import {configError, verificationFailed} from '../../core/errors';
import {callProvider, type HttpResult, type ProviderHttp} from '../../core/http';
import {header} from '../../core/request';
import type {IncomingRequest} from '../../core/types';
import {hmacSha256Hex, parseSignatureHeader, safeEqual, withinTolerance} from '../../core/webhooks';
import {VENTI_API, type VentiErrorResponse, type VentiEvent} from './api';

export interface VentiConfig {
    /** `key_test_...` o `key_live_...`. La clave define el modo. */
    apiKey: string;
    /** Secreto del webhook (`whs_...`). Sin él no se verifican notificaciones. */
    webhookSecret?: string;
    /** Tolerancia para el `t` de la firma. Default 300 segundos. */
    signatureToleranceSeconds?: number;
}

/** Una API key para todos los productos de Venti: host, errores, idempotencia y firma. */
export class VentiCore implements ProviderHttp {
    readonly label = 'Venti';

    constructor(readonly config: VentiConfig) {
    }

    url(path: string): string {
        return `${VENTI_API.baseUrl}${path}`;
    }

    headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
            ...extra,
        };
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as VentiErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        return {
            code: data?.code ?? data?.error?.code,
            message: data?.messages?.join('; ') ?? data?.error?.message ?? data?.type,
        };
    }

    request<T>(
        method: string,
        path: string,
        options: { body?: unknown; idempotencyKey?: string } = {},
    ): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: this.headers(options.idempotencyKey ? {'X-Idempotency': options.idempotencyKey} : {}),
            ...(options.body !== undefined ? {body: JSON.stringify(options.body), rawBody: options.body} : {}),
        });
    }

    /** `venti-signature: t=<epoch>,v1=<hex>`; HMAC-SHA256 de `<t>.<cuerpo crudo>`. */
    verifyNotification(request: IncomingRequest): VentiEvent {
        const secret = this.config.webhookSecret;
        if (!secret) throw configError(this.label, 'falta webhookSecret para verificar notificaciones');
        const signature = parseSignatureHeader(header(request, VENTI_API.signatureHeader));
        if (!signature.t || !signature.v1) throw verificationFailed(this.label, `falta ${VENTI_API.signatureHeader}`);
        if (!withinTolerance(signature.t, this.config.signatureToleranceSeconds ?? 300)) {
            throw verificationFailed(this.label, 'la firma expiró');
        }
        const body = request.body ?? '';
        const expected = hmacSha256Hex(secret, `${signature.t}.${body}`);
        if (!safeEqual(expected, signature.v1)) throw verificationFailed(this.label, 'la firma no coincide');
        try {
            return JSON.parse(body) as VentiEvent;
        } catch {
            throw verificationFailed(this.label, 'el cuerpo no es JSON');
        }
    }
}
