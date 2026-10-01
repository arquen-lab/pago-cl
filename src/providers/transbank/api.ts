// https://www.transbankdevelopers.cl/referencia/webpay
// https://www.transbankdevelopers.cl/documentacion/webpay-plus

import type {PaymentStatus} from '../../core/types';

export const TRANSBANK_API = {
    hosts: {
        sandbox: 'https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2',
        production: 'https://webpay3g.transbank.cl/rswebpaytransaction/api/webpay/v1.2',
    },
    paths: {
        transactions: '/transactions',
        transaction: (token: string) => `/transactions/${token}`,
        capture: (token: string) => `/transactions/${token}/capture`,
        refunds: (token: string) => `/transactions/${token}/refunds`,
    },
    headers: {
        contentType: 'Content-Type',
        apiKeyId: 'Tbk-Api-Key-Id',
        apiKeySecret: 'Tbk-Api-Key-Secret',
    },
    limits: {
        buyOrder: 26,
        sessionId: 61,
        returnUrl: 255,
    },
} as const;

export interface TransbankCreateRequest {
    buy_order: string;
    session_id: string;
    amount: number;
    return_url: string;
}

export interface TransbankCreateResponse {
    token: string;
    url: string;
}

/** Respuesta de commit y de status. En INITIALIZED faltan casi todos los campos. */
export interface TransbankTransactionResponse {
    buy_order: string;
    session_id?: string;
    status: string;
    response_code?: number;
    amount: number;
    authorization_code?: string;
    payment_type_code?: string;
    vci?: string;
    balance?: number;
    installments_number?: number;
    card_detail?: { card_number?: string };
    transaction_date?: string;
    accounting_date?: string;
}

export interface TransbankCaptureRequest {
    buy_order: string;
    authorization_code: string;
    capture_amount: number;
}

export interface TransbankCaptureResponse {
    token?: string;
    authorization_code?: string;
    authorization_date?: string;
    captured_amount?: number;
    response_code: number;
}

export interface TransbankRefundResponse {
    type: 'REVERSED' | 'NULLIFIED';
    authorization_code?: string;
    authorization_date?: string;
    balance?: number;
    nullified_amount?: number;
    response_code?: number;
}

export interface TransbankErrorResponse {
    error_message?: string;
}

/** Estados documentados de una transacción Webpay Plus. */
export const TRANSBANK_STATUSES = [
    'INITIALIZED',
    'AUTHORIZED',
    'REVERSED',
    'FAILED',
    'NULLIFIED',
    'PARTIALLY_NULLIFIED',
    'CAPTURED',
] as const;

export function transbankRedirectUrl(data: TransbankCreateResponse): string {
    return `${data.url}?token_ws=${data.token}`;
}

export function transbankIsAuthorized(data: TransbankTransactionResponse): boolean {
    return data.status === 'AUTHORIZED' && data.response_code === 0;
}

/**
 * Estado común a partir de la respuesta. `deferred` cambia AUTHORIZED por el estado retenido.
 * Devuelve también el monto reembolsado que se deduce del estado.
 */
export function mapTransbankStatus(
    data: TransbankTransactionResponse,
    deferred: boolean,
): { status: PaymentStatus; refundedAmount: number } {
    switch (data.status) {
        case 'INITIALIZED':
            return {status: 'PENDING', refundedAmount: 0};
        case 'AUTHORIZED':
            if (!transbankIsAuthorized(data)) return {status: 'REJECTED', refundedAmount: 0};
            return {status: deferred ? 'AUTHORIZED' : 'PAID', refundedAmount: 0};
        case 'CAPTURED':
            return {status: 'PAID', refundedAmount: 0};
        case 'REVERSED':
        case 'NULLIFIED':
            return {status: 'PAID', refundedAmount: data.amount};
        case 'PARTIALLY_NULLIFIED':
            return {
                status: 'PAID',
                refundedAmount: data.balance !== undefined ? data.amount - data.balance : 0,
            };
        case 'FAILED':
            return {status: 'REJECTED', refundedAmount: 0};
        default:
            return {status: 'PENDING', refundedAmount: 0};
    }
}
