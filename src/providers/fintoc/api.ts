// Checkout Sessions v2 y Refunds de Fintoc:
// https://docs.fintoc.com/api/payments-api/checkout-sessions/checkout-session-object
// https://docs.fintoc.com/api/payments-api/refunds/refund-object
// https://docs.fintoc.com/guides/resources/webhooks-walkthrough/webhooks-validating

import type {PaymentStatus, RefundStatus} from '../../core/types';

export const FINTOC_API = {
    /** Un solo host: `test` o `live` lo decide la clave (`sk_test_` / `sk_live_`). */
    baseUrl: 'https://api.fintoc.com',
    paths: {
        checkoutSessions: '/v2/checkout_sessions',
        checkoutSession: (id: string) => `/v2/checkout_sessions/${id}`,
        expireCheckoutSession: (id: string) => `/v2/checkout_sessions/${id}/expire`,
        refunds: '/v1/refunds',
        refund: (id: string) => `/v1/refunds/${id}`,
    },
    signatureHeader: 'fintoc-signature',
    /** La sesión debe durar al menos 10 minutos. */
    minExpirationMinutes: 10,
    /** Fintoc no tiene un campo para el id de orden del comercio: viaja en `metadata`. */
    orderIdMetadataKey: 'order_id',
} as const;

export const FINTOC_PAYMENT_METHOD_TYPES = ['bank_transfer', 'card', 'installments'] as const;

export interface FintocCheckoutSessionRequest {
    currency: string;
    amount: number;
    success_url: string;
    cancel_url: string;
    customer_email?: string;
    expires_at?: string;
    metadata?: Record<string, string>;
    payment_method_types?: string[];
}

export interface FintocPaymentIntent {
    id: string;
    object?: 'payment_intent';
    amount?: number;
    currency?: string;
    /** created · in_progress · pending · requires_action · succeeded · failed · rejected · expired */
    status: string;
    error_reason?: string | null;
    payment_type?: string;
    reference_id?: string | null;
    transaction_date?: string | null;
    sender_account?: { institution_id?: string } | null;
    next_action?: { type?: string } | null;
    metadata?: Record<string, string>;
}

export interface FintocCheckoutSession {
    id: string;
    object?: 'checkout_session';
    amount: number | null;
    currency: string;
    /** created · in_progress · finished · expired */
    status: string;
    flow?: string;
    redirect_url?: string | null;
    session_token?: string | null;
    expires_at?: string;
    metadata?: Record<string, string>;
    payment_resource?: { payment_intent?: FintocPaymentIntent | null } | null;
}

export interface FintocRefund {
    id: string;
    object?: 'refund';
    amount: number;
    currency?: string;
    /** created · in_progress · succeeded · failed · canceled */
    status: string;
    failure_code?: string | null;
    resource_id?: string;
    resource_type?: string;
    metadata?: Record<string, string>;
}

export interface FintocEvent<T = unknown> {
    id: string;
    object?: 'event';
    type: string;
    mode?: string;
    created_at?: string;
    data: T;
}

export interface FintocErrorResponse {
    error?: { type?: string; code?: string; message?: string; param?: string | null; doc_url?: string };
}

const TERMINAL_INTENT: Record<string, PaymentStatus> = {
    succeeded: 'PAID',
    failed: 'REJECTED',
    rejected: 'REJECTED',
    expired: 'EXPIRED',
};

/**
 * El intento de pago más reciente (`payment_intent`) manda cuando ya terminó; si no, la sesión.
 * Una sesión `finished` puede tener el pago aún en `requires_action`: sigue PENDING.
 */
export function mapFintocSession(session: Pick<FintocCheckoutSession, 'status' | 'payment_resource'>): {
    status: PaymentStatus;
    detail?: string;
} {
    const intent = session.payment_resource?.payment_intent;
    if (intent) {
        const terminal = TERMINAL_INTENT[intent.status];
        if (terminal) return {status: terminal, detail: intent.error_reason ?? undefined};
        if (session.status === 'expired') return {status: 'EXPIRED'};
        return {status: 'PENDING'};
    }
    if (session.status === 'expired') return {status: 'EXPIRED'};
    return {status: 'PENDING'};
}

export function mapFintocRefundStatus(status: string): RefundStatus {
    switch (status) {
        case 'succeeded':
            return 'SUCCEEDED';
        case 'failed':
            return 'FAILED';
        case 'canceled':
            return 'CANCELED';
        default:
            return 'PENDING';
    }
}
