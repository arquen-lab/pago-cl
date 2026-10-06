import {configError, verificationFailed} from '../../core/errors';
import {callProvider, type FetchLike, type HttpResult, type ProviderHttp} from '../../core/http';
import {header} from '../../core/request';
import type {Environment, IncomingRequest} from '../../core/types';
import {safeEqual, sha256Hex} from '../../core/webhooks';
import {KLAP_API, type KlapErrorResponse} from './api';

export interface KlapConfig {
    /** Transporte HTTP propio. Si falta, se usa el `fetch` global, resuelto en cada llamada. Ver `FetchLike`. */
    fetch?: FetchLike;
    /** Header `apikey` de todas las llamadas. También firma las notificaciones. */
    apiKey: string;
    /** Default: `sandbox`. */
    environment?: Environment;
    /** URL por defecto para los webhooks de confirmación y rechazo de cada orden. */
    notificationUrl?: string;
}

/** Klap exige dos webhooks por orden; el SDK los distingue con `?kind=confirm|reject`. */
export type KlapNotificationKind = 'confirm' | 'reject';

/** Una `apikey` para todos los productos de Klap: host, errores y verificación de webhooks. */
export class KlapCore implements ProviderHttp {
    readonly label = 'Klap';

    get fetch(): FetchLike | undefined {
        return this.config.fetch;
    }
    readonly environment: Environment;

    constructor(readonly config: KlapConfig) {
        if (!config.apiKey?.trim()) throw configError(this.label, 'falta apiKey');
        this.environment = config.environment ?? 'sandbox';
    }

    url(path: string): string {
        return `${KLAP_API.hosts[this.environment]}${path}`;
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as KlapErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        return {code: data?.code, message: data?.message};
    }

    request<T>(method: string, path: string, body?: unknown): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: {'Content-Type': 'application/json', apikey: this.config.apiKey},
            ...(body !== undefined ? {body: JSON.stringify(body), rawBody: body} : {}),
        });
    }

    /** URL de notificación con el tipo en la query. */
    notificationUrl(kind: KlapNotificationKind, base: string | undefined): string | undefined {
        const chosen = base ?? this.config.notificationUrl;
        if (!chosen) return undefined;
        const url = new URL(chosen);
        url.searchParams.set('kind', kind);
        return url.toString();
    }

    /**
     * El header `Apikey` de la notificación es sha256(reference_id + order_id + apikey).
     * Es un hash simple: no cubre el monto ni el cuerpo.
     */
    verifyNotification(request: IncomingRequest, referenceId: string, orderId: string): void {
        const provided = header(request, 'apikey')?.trim().toLowerCase();
        if (!provided) throw verificationFailed(this.label, 'falta el header Apikey');
        const expected = sha256Hex(`${referenceId}${orderId}${this.config.apiKey}`);
        if (!safeEqual(expected, provided)) throw verificationFailed(this.label, 'el header Apikey no coincide');
    }
}
