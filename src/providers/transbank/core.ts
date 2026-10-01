import {configError} from '../../core/errors';
import {callProvider, type HttpResult, type ProviderHttp} from '../../core/http';
import type {Environment} from '../../core/types';
import {TRANSBANK_API, type TransbankErrorResponse} from './api';

export interface TransbankConfig {
    /** Código de comercio Webpay Plus (`Tbk-Api-Key-Id`). */
    commerceCode: string;
    /** Llave secreta (`Tbk-Api-Key-Secret`). */
    apiKey: string;
    /** Default: `sandbox` (host de integración). */
    environment?: Environment;
    /**
     * Código de comercio de Webpay Plus Captura Diferida. Si está, `create({ capture: 'manual' })`
     * autoriza sin cobrar y el cobro se hace con `capture()`.
     */
    deferredCommerceCode?: string;
    /**
     * Llave secreta del código de comercio diferido. Cada código de comercio tiene la suya:
     * en producción es obligatoria junto con `deferredCommerceCode`. En sandbox, si falta,
     * se usa `apiKey` (la integración comparte una sola llave).
     */
    deferredApiKey?: string;
}

/** Lo común a todos los productos REST de Transbank: host, headers y errores. */
export class TransbankCore implements ProviderHttp {
    readonly label = 'Transbank';
    readonly environment: Environment;

    constructor(private readonly config: TransbankConfig) {
        this.environment = config.environment ?? 'sandbox';
        if (this.environment === 'production' && this.deferredCommerceCode && !config.deferredApiKey?.trim()) {
            throw configError(this.label, 'falta deferredApiKey: el código de comercio diferido tiene su propia llave');
        }
    }

    url(path: string): string {
        return `${TRANSBANK_API.hosts[this.environment]}${path}`;
    }

    get deferredCommerceCode(): string | undefined {
        return this.config.deferredCommerceCode?.trim() || undefined;
    }

    /** Headers con el código de comercio y la llave normales o los del diferido. */
    headers(deferred = false): Record<string, string> {
        const commerceCode = deferred ? this.deferredCommerceCode : this.config.commerceCode;
        if (!commerceCode) throw configError(this.label, 'falta deferredCommerceCode para captura diferida');
        const apiKey = deferred ? this.config.deferredApiKey?.trim() || this.config.apiKey : this.config.apiKey;
        return {
            [TRANSBANK_API.headers.contentType]: 'application/json',
            [TRANSBANK_API.headers.apiKeyId]: commerceCode,
            [TRANSBANK_API.headers.apiKeySecret]: apiKey,
        };
    }

    parseError(_status: number, body: unknown): { code?: string; message?: string } {
        const data = body as TransbankErrorResponse | string | undefined;
        if (typeof data === 'string') return {message: data};
        return {message: data?.error_message};
    }

    request<T>(method: string, path: string, body?: unknown, deferred = false): Promise<HttpResult<T>> {
        return callProvider<T>(this, {
            method,
            url: this.url(path),
            headers: this.headers(deferred),
            ...(body !== undefined ? {body: JSON.stringify(body), rawBody: body} : {}),
        });
    }
}
