import querystring from 'node:querystring';
import {callProvider, type HttpResult, type ProviderHttp} from '../../core/http';
import {hmacSha256Hex} from '../../core/webhooks';
import type {Environment} from '../../core/types';
import {FLOW_API, type FlowErrorResponse, type FlowParams} from './api';

export interface FlowConfig {
    /** Se envía como `apiKey` en cada llamada. */
    apiKey: string;
    /** Firma cada llamada (`s`). */
    secretKey: string;
    /** Default: `sandbox`. */
    environment?: Environment;
    /** URL por defecto para `urlConfirmation` y `urlCallBack` de todos los cobros. */
    notificationUrl?: string;
}

/** Flow avisa con un `token` a secas; el sufijo dice qué consultar. */
export type FlowNotificationKind = 'payment' | 'refund';

/** Un solo par de claves para todos los productos de Flow: firma, hosts y errores. */
export class FlowCore implements ProviderHttp {
    readonly label = 'Flow';
    readonly environment: Environment;

    constructor(readonly config: FlowConfig) {
        this.environment = config.environment ?? 'sandbox';
    }

    url(path: string): string {
        return `${FLOW_API.hosts[this.environment]}${path}`;
    }

    /** Ordena por nombre, concatena nombre+valor (apiKey incluida) y firma HMAC-SHA256. */
    sign(params: FlowParams): string {
        const keys = Object.keys(params).sort();
        let toSign = '';
        for (const key of keys) {
            const value = params[key];
            if (value === undefined) continue;
            toSign += key + String(value);
        }
        return hmacSha256Hex(this.config.secretKey, toSign);
    }

    signedQuery(params: FlowParams): string {
        const withKey = {apiKey: this.config.apiKey, ...params};
        const signed: Record<string, string | number> = {s: this.sign(withKey)};
        for (const [key, value] of Object.entries(withKey)) {
            if (value !== undefined) signed[key] = value;
        }
        return querystring.stringify(signed);
    }

    /** Lo que se registra en rawRequest: sin apiKey ni firma. */
    publicParams(params: FlowParams): Record<string, string | number> {
        const body: Record<string, string | number> = {};
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || key === 'apiKey' || key === 's') continue;
            body[key] = value;
        }
        return body;
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as FlowErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        return {
            code: data?.code !== undefined ? String(data.code) : undefined,
            message: data?.message,
        };
    }

    post<T>(path: string, params: FlowParams): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method: 'POST',
            url: this.url(path),
            headers: {'Content-Type': FLOW_API.contentType},
            body: this.signedQuery(params),
            rawBody: this.publicParams(params),
        });
    }

    get<T>(path: string, params: FlowParams): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method: 'GET',
            url: `${this.url(path)}?${this.signedQuery(params)}`,
            rawBody: this.publicParams(params),
        });
    }

    /** URL de notificación con el tipo en la query. */
    notificationUrl(kind: FlowNotificationKind, base: string | undefined): string | undefined {
        const chosen = base ?? this.config.notificationUrl;
        if (!chosen) return undefined;
        const url = new URL(chosen);
        url.searchParams.set('kind', kind);
        return url.toString();
    }
}
