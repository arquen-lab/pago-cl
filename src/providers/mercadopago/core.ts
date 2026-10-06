import {configError, verificationFailed} from '../../core/errors';
import {callProvider, type FetchLike, type HttpResult, type ProviderHttp} from '../../core/http';
import {header, queryParams} from '../../core/request';
import type {Environment, IncomingRequest} from '../../core/types';
import {hmacSha256Hex, parseSignatureHeader, safeEqual, withinTolerance} from '../../core/webhooks';
import {MERCADOPAGO_API, type MercadoPagoErrorResponse} from './api';

export interface MercadoPagoConfig {
    /** Transporte HTTP propio. Si falta, se usa el `fetch` global, resuelto en cada llamada. Ver `FetchLike`. */
    fetch?: FetchLike;
    /** Access token de la aplicación (de prueba o productivo). */
    accessToken: string;
    /** Clave secreta de webhooks de la aplicación. Sin ella no se pueden verificar notificaciones. */
    webhookSecret?: string;
    /** Informativo: Mercado Pago usa el mismo host y decide por el token. */
    environment?: Environment;
    /** Tolerancia para el `ts` de la firma. Default 300 segundos. */
    signatureToleranceSeconds?: number;
}

/** Un solo host y token para todos los productos: headers, errores y firma de webhooks. */
export class MercadoPagoCore implements ProviderHttp {
    readonly label = 'Mercado Pago';

    get fetch(): FetchLike | undefined {
        return this.config.fetch;
    }

    constructor(readonly config: MercadoPagoConfig) {
    }

    url(path: string): string {
        return `${MERCADOPAGO_API.baseUrl}${path}`;
    }

    headers(extra: Record<string, string> = {}): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.accessToken}`,
            ...extra,
        };
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as MercadoPagoErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        const cause = data?.cause?.[0];
        return {
            code: data?.code ?? data?.error ?? (cause?.code !== undefined ? String(cause.code) : undefined),
            message: data?.message ?? cause?.description,
        };
    }

    request<T>(
        method: string,
        path: string,
        options: { body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: this.headers(options.headers),
            ...(options.body !== undefined ? {body: JSON.stringify(options.body), rawBody: options.body} : {}),
        });
    }

    /**
     * Verifica `x-signature` (ts=..., v1=...) con el manifest
     * `id:[data.id];request-id:[x-request-id];ts:[ts];` firmado con la clave secreta.
     */
    verifyNotification(request: IncomingRequest): void {
        const secret = this.config.webhookSecret;
        if (!secret) throw configError(this.label, 'falta webhookSecret para verificar notificaciones');
        const signature = parseSignatureHeader(header(request, 'x-signature'));
        const ts = signature.ts;
        const v1 = signature.v1;
        if (!ts || !v1) throw verificationFailed(this.label, 'falta x-signature');
        if (!withinTolerance(ts, this.config.signatureToleranceSeconds ?? 300)) {
            throw verificationFailed(this.label, 'la firma expiró');
        }
        const dataId = queryParams(request)['data.id'];
        const requestId = header(request, 'x-request-id');
        const parts: string[] = [];
        if (dataId) parts.push(`id:${/^[a-zA-Z0-9]+$/.test(dataId) && /[a-zA-Z]/.test(dataId) ? dataId.toLowerCase() : dataId};`);
        if (requestId) parts.push(`request-id:${requestId};`);
        parts.push(`ts:${ts};`);
        const expected = hmacSha256Hex(secret, parts.join(''));
        if (!safeEqual(expected, v1)) throw verificationFailed(this.label, 'la firma no coincide');
    }
}
