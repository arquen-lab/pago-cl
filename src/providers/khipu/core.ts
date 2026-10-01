import {configError, verificationFailed} from '../../core/errors';
import {callProvider, type HttpResult, type ProviderHttp} from '../../core/http';
import {header} from '../../core/request';
import type {IncomingRequest} from '../../core/types';
import {hmacSha256Base64, parseSignatureHeader, safeEqual, withinTolerance} from '../../core/webhooks';
import {KHIPU_API, type KhipuErrorResponse} from './api';

export interface KhipuConfig {
    /** API key de la cuenta de cobro (header `x-api-key`). La cuenta en modo desarrollador es el sandbox. */
    apiKey: string;
    /** Secreto de la cuenta de cobro. Firma las notificaciones; sin él no se pueden verificar. */
    webhookSecret?: string;
    /** Tolerancia para el `t` de la firma, en segundos. Default 300. */
    signatureToleranceSeconds?: number;
}

/** Una API key para todos los productos de Khipu: host, errores y verificación de webhooks. */
export class KhipuCore implements ProviderHttp {
    readonly label = 'Khipu';

    constructor(readonly config: KhipuConfig) {
        if (!config.apiKey?.trim()) throw configError(this.label, 'falta apiKey');
    }

    url(path: string): string {
        return `${KHIPU_API.baseUrl}${path}`;
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as KhipuErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        const fromList = data?.errors?.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message)).filter(Boolean).join('; ');
        return {code: data?.code ?? data?.type, message: data?.message ?? data?.error ?? (fromList || undefined)};
    }

    request<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: {'Content-Type': 'application/json', 'x-api-key': this.config.apiKey},
            ...(body !== undefined ? {body: JSON.stringify(body), rawBody: body} : {}),
        });
    }

    /**
     * `x-khipu-signature: t=<ms>,s=<base64>`; `s` es HMAC-SHA256 en base64 de `<t>.<cuerpo crudo>`
     * con el secreto de la cuenta. El cuerpo no se puede reordenar ni reindentar.
     */
    verifyNotification(request: IncomingRequest): void {
        const secret = this.config.webhookSecret;
        if (!secret) throw configError(this.label, 'falta webhookSecret para verificar notificaciones');
        const signature = parseSignatureHeader(header(request, KHIPU_API.signatureHeader));
        if (!signature.t || !signature.s) throw verificationFailed(this.label, `falta ${KHIPU_API.signatureHeader}`);
        if (!withinTolerance(signature.t, this.config.signatureToleranceSeconds ?? 300)) {
            throw verificationFailed(this.label, 'la firma expiró');
        }
        const expected = hmacSha256Base64(secret, `${signature.t}.${request.body ?? ''}`);
        if (!safeEqual(expected, signature.s)) throw verificationFailed(this.label, 'la firma no coincide');
    }
}
