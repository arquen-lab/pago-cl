// Manual de Integración API Web Checkout, Getnet Chile, versión 2.4 (mayo 2026).

import type {PaymentStatus} from '../../core/types';

export const GETNET_API = {
    hosts: {
        sandbox: 'https://checkout.test.getnet.cl',
        production: 'https://checkout.getnet.cl',
    },
    paths: {
        createSession: '/api/session/',
        session: (requestId: string) => `/api/session/${requestId}`,
        reverse: '/api/reverse',
    },
    limits: {
        reference: 32,
        description: 255,
        returnUrl: 255,
        userAgent: 255,
        ipAddress: 16,
    },
    /** Mínimo que exige la API entre la creación y la expiración. */
    minExpirationMinutes: 5,
    defaultExpirationMinutes: 15,
} as const;

/** Caracteres que la API rechaza en cualquier campo. */
export const GETNET_FORBIDDEN_CHARS = /[[\]{}|"'\\*=~¡!]/;

export interface GetnetAuth {
    login: string;
    tranKey: string;
    nonce: string;
    seed: string;
}

export interface GetnetStatus {
    status: string;
    reason?: string;
    message?: string;
    date?: string;
}

export interface GetnetPerson {
    document?: string;
    documentType?: string;
    name?: string;
    surname?: string;
    email?: string;
    mobile?: string;
}

export interface GetnetCreateRequest {
    auth: GetnetAuth;
    locale: string;
    buyer?: GetnetPerson;
    payment: {
        reference: string;
        description: string;
        amount: { currency: string; total: number };
    };
    expiration: string;
    returnUrl: string;
    cancelUrl?: string;
    ipAddress: string;
    userAgent: string;
    skipResult?: boolean;
    fields?: Array<{ keyword: string; value: string; displayOn?: string }>;
}

export interface GetnetCreateResponse {
    status: GetnetStatus;
    requestId?: number | string;
    processUrl?: string;
}

export interface GetnetTransaction {
    status: GetnetStatus;
    internalReference: number | string;
    reference: string;
    paymentMethod?: string;
    paymentMethodName?: string;
    issuerName?: string;
    amount?: { from?: { currency: string; total: number }; to?: { currency: string; total: number } };
    receipt?: string;
    franchise?: string;
    refunded?: boolean;
    authorization?: string;
    processorFields?: Array<{ keyword: string; value: unknown }>;
}

export interface GetnetSessionResponse {
    requestId: number | string;
    status: GetnetStatus;
    request?: { payment?: { reference?: string; amount?: { currency: string; total: number } } };
    payment?: GetnetTransaction[] | null;
}

export interface GetnetReverseResponse {
    status: GetnetStatus;
    payment?: GetnetTransaction;
}

export interface GetnetNotification {
    status: GetnetStatus;
    requestId: number | string;
    reference: string;
    signature: string;
}

/**
 * Estados de sesión del manual: PENDING, APPROVED, REJECTED (y REFUNDED como
 * estado de transacción). Una sesión rechazada por expiración trae `reason` EX.
 */
export function mapGetnetStatus(status: GetnetStatus): PaymentStatus {
    switch (status.status) {
        case 'APPROVED':
        case 'APPROVED_PARTIAL':
        case 'REFUNDED':
            return 'PAID';
        case 'REJECTED':
        case 'FAILED':
            return status.reason === 'EX' ? 'EXPIRED' : 'REJECTED';
        case 'PARTIAL_EXPIRED':
            return 'EXPIRED';
        default:
            return 'PENDING';
    }
}
