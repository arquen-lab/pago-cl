import {createHash, randomBytes} from 'node:crypto';
import {configError, providerError, verificationFailed} from '../../core/errors';
import {callProvider, type FetchLike, type HttpResult, type ProviderHttp} from '../../core/http';
import type {Environment} from '../../core/types';
import {safeEqual, sha256Hex} from '../../core/webhooks';
import {GETNET_API, type GetnetAuth, type GetnetNotification, type GetnetStatus} from './api';

export interface GetnetConfig {
    /** Transporte HTTP propio. Si falta, se usa el `fetch` global, resuelto en cada llamada. Ver `FetchLike`. */
    fetch?: FetchLike;
    /** Identificador del sitio, entregado por Getnet. */
    login: string;
    /** Firma cada llamada y las notificaciones. */
    secretKey: string;
    /** Default: `sandbox` (checkout.test.getnet.cl). */
    environment?: Environment;
    /** Default `es_CL`. */
    locale?: string;
}

/**
 * Autenticación WSS UsernameToken de Getnet (PlaceToPay): el objeto `auth` viaja
 * en el cuerpo de cada llamada con `tranKey = Base64(SHA-256(nonce + seed + secretKey))`.
 */
export class GetnetCore implements ProviderHttp {
    readonly label = 'Getnet';

    get fetch(): FetchLike | undefined {
        return this.config.fetch;
    }
    readonly environment: Environment;
    readonly locale: string;

    constructor(private readonly config: GetnetConfig) {
        if (!config.login?.trim() || !config.secretKey?.trim()) {
            throw configError(this.label, 'faltan login o secretKey');
        }
        this.environment = config.environment ?? 'sandbox';
        this.locale = config.locale ?? 'es_CL';
    }

    url(path: string): string {
        return `${GETNET_API.hosts[this.environment]}${path}`;
    }

    auth(now = new Date()): GetnetAuth {
        const nonceRaw = randomBytes(16);
        const seed = now.toISOString();
        const tranKey = createHash('sha256').update(Buffer.concat([nonceRaw, Buffer.from(seed + this.config.secretKey)])).digest('base64');
        return {login: this.config.login, tranKey, nonce: nonceRaw.toString('base64'), seed};
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as { status?: GetnetStatus } | string | undefined;
        if (typeof data === 'string') return {message: data};
        return {code: data?.status?.reason, message: data?.status?.message};
    }

    /** POST con `auth` en el cuerpo. Un 2xx con `status.status = FAILED` también es error. */
    async post<T extends {
        status?: GetnetStatus
    }>(path: string, body: Record<string, unknown>): Promise<HttpResult<T>> {
        const full = {auth: this.auth(), ...body};
        const result = await callProvider<T>(this, {
            method: 'POST',
            url: this.url(path),
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(full),
            rawBody: body,
        });
        if (result.data?.status?.status === 'FAILED') {
            throw providerError(this.label, result.data.status.message ?? 'FAILED', {
                httpStatus: result.status,
                providerCode: result.data.status.reason,
                retryable: false,
                raw: result.data,
            });
        }
        return result;
    }

    /** `signature` = sha256(requestId + status + date + secretKey), con prefijo opcional `sha256:`. */
    verifyNotification(notification: GetnetNotification): void {
        const provided = (notification.signature ?? '').replace(/^sha256:/, '').trim().toLowerCase();
        if (!provided) throw verificationFailed(this.label, 'falta signature');
        const expected = sha256Hex(`${notification.requestId}${notification.status?.status ?? ''}${notification.status?.date ?? ''}${this.config.secretKey}`);
        if (!safeEqual(expected, provided)) throw verificationFailed(this.label, 'la firma no coincide');
    }
}
