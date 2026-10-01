// https://www.mercadopago.cl/developers/es/docs/checkout-pro-preferences
// https://www.mercadopago.cl/developers/es/reference/online-payments/checkout-pro-preferences

import type {PaymentStatus, RefundStatus} from '../../core/types';

export const MERCADOPAGO_API = {
    baseUrl: 'https://api.mercadopago.com',
    paths: {
        preferences: '/checkout/preferences',
        payment: (paymentId: string) => `/v1/payments/${paymentId}`,
        searchPayments: '/v1/payments/search',
        refunds: (paymentId: string) => `/v1/payments/${paymentId}/refunds`,
        refund: (paymentId: string, refundId: string) => `/v1/payments/${paymentId}/refunds/${refundId}`,
    },
    limits: {
        externalReference: 64,
        statementDescriptor: 13,
        notificationUrl: 248,
    },
} as const;

export interface MercadoPagoPreferenceRequest {
    external_reference: string;
    items: Array<{
        id: string;
        title: string;
        description?: string;
        quantity: number;
        unit_price: number;
        currency_id: string;
    }>;
    back_urls: { success: string; failure: string; pending: string };
    auto_return?: 'approved' | 'all';
    payer?: { email?: string; name?: string; phone?: { number?: string } };
    metadata?: Record<string, unknown>;
    notification_url?: string;
    statement_descriptor?: string;
    binary_mode?: boolean;
    expires?: boolean;
    expiration_date_from?: string;
    expiration_date_to?: string;
    payment_methods?: {
        excluded_payment_methods?: Array<{ id: string }>;
        excluded_payment_types?: Array<{ id: string }>;
        installments?: number;
    };

    [key: string]: unknown;
}

export interface MercadoPagoPreferenceResponse {
    id: string;
    init_point: string;
    sandbox_init_point?: string;
}

export interface MercadoPagoPaymentResponse {
    id: number | string;
    external_reference?: string;
    status: string;
    status_detail?: string;
    transaction_amount: number;
    transaction_amount_refunded?: number;
    currency_id?: string;
    authorization_code?: string;
    payment_method_id?: string;
    date_created?: string;
    live_mode?: boolean;
}

export interface MercadoPagoSearchResponse {
    results: MercadoPagoPaymentResponse[];
    paging?: { total: number };
}

export interface MercadoPagoRefundResponse {
    id: number | string;
    payment_id?: number | string;
    amount: number;
    status: string;
}

export interface MercadoPagoErrorResponse {
    message?: string;
    error?: string;
    status?: number;
    code?: string;
    cause?: Array<{ code?: string | number; description?: string }>;
}

export interface MercadoPagoWebhookBody {
    id?: number | string;
    type?: string;
    action?: string;
    live_mode?: boolean;
    data?: { id?: string | number };
}

/**
 * Estados documentados del pago. `cancelled` incluye los expirados (status_detail `expired`).
 * `refunded`, `charged_back` y `partially_refunded` se expresan en refundedAmount.
 */
export function mapMercadoPagoStatus(data: MercadoPagoPaymentResponse): {
    status: PaymentStatus;
    refundedAmount: number;
} {
    const refunded = data.transaction_amount_refunded ?? 0;
    switch (data.status) {
        case 'approved':
            return {status: 'PAID', refundedAmount: refunded};
        case 'authorized':
            return {status: 'AUTHORIZED', refundedAmount: 0};
        case 'pending':
        case 'in_process':
        case 'in_mediation':
            return {status: 'PENDING', refundedAmount: 0};
        case 'rejected':
            return {status: 'REJECTED', refundedAmount: 0};
        case 'cancelled':
            return {status: data.status_detail === 'expired' ? 'EXPIRED' : 'CANCELED', refundedAmount: 0};
        case 'refunded':
            return {status: 'PAID', refundedAmount: refunded || data.transaction_amount};
        case 'charged_back':
            return {status: 'PAID', refundedAmount: refunded || data.transaction_amount};
        default:
            return {status: 'PENDING', refundedAmount: refunded};
    }
}

export function mapMercadoPagoRefundStatus(status: string): RefundStatus {
    switch (status) {
        case 'approved':
            return 'SUCCEEDED';
        case 'rejected':
            return 'FAILED';
        case 'cancelled':
            return 'CANCELED';
        default:
            return 'PENDING';
    }
}
