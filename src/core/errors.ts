export type PaymentErrorCode =
    | 'INVALID_INPUT'
    | 'MISSING_FIELD'
    | 'NOT_SUPPORTED'
    | 'PROVIDER_ERROR'
    | 'RETURN_MISMATCH'
    | 'VERIFICATION_FAILED'
    | 'CONFIG_ERROR';

/** Sugerencia de estado HTTP para quien exponga el error. */
export type PaymentErrorStatus = 400 | 401 | 502;

export interface ProviderErrorDetails {
    provider: string;
    httpStatus?: number;
    providerCode?: string;
    /** true cuando conviene reintentar (red, timeout, 5xx). */
    retryable: boolean;
    raw?: unknown;
}

export class PaymentError extends Error {
    readonly code: PaymentErrorCode;
    readonly status: PaymentErrorStatus;
    /** Campo afectado en INVALID_INPUT y MISSING_FIELD. */
    readonly field?: string;
    readonly provider?: ProviderErrorDetails;

    constructor(
        code: PaymentErrorCode,
        message: string,
        options: { status?: PaymentErrorStatus; field?: string; provider?: ProviderErrorDetails } = {},
    ) {
        super(message);
        this.name = 'PaymentError';
        this.code = code;
        this.status = options.status ?? 400;
        this.field = options.field;
        this.provider = options.provider;
    }
}

export function isPaymentError(error: unknown): error is PaymentError {
    return (
        error instanceof PaymentError ||
        (error instanceof Error && error.name === 'PaymentError' && typeof (error as PaymentError).code === 'string')
    );
}

export function invalidInput(field: string, message: string): PaymentError {
    return new PaymentError('INVALID_INPUT', message, {field});
}

export function missingField(field: string, provider: string): PaymentError {
    return new PaymentError('MISSING_FIELD', `${provider} necesita "${field}".`, {field});
}

export function notSupported(provider: string, operation: string): PaymentError {
    return new PaymentError('NOT_SUPPORTED', `${provider} no soporta ${operation}.`);
}

export function returnMismatch(provider: string, detail: string): PaymentError {
    return new PaymentError('RETURN_MISMATCH', `El retorno de ${provider} no corresponde a esta orden: ${detail}.`);
}

export function verificationFailed(provider: string, detail: string): PaymentError {
    return new PaymentError('VERIFICATION_FAILED', `Notificación de ${provider} no verificada: ${detail}.`, {
        status: 401,
    });
}

export function configError(provider: string, detail: string): PaymentError {
    return new PaymentError('CONFIG_ERROR', `${provider}: ${detail}.`);
}

export function providerError(
    provider: string,
    message: string,
    details: Omit<ProviderErrorDetails, 'provider'>,
): PaymentError {
    const trimmed = message.trim() || 'request failed';
    return new PaymentError('PROVIDER_ERROR', `${provider}: ${trimmed}`, {
        status: 502,
        provider: {provider, ...details},
    });
}
