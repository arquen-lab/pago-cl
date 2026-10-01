// https://docs.ventipay.com/docs/checkouts-quickstart
// https://docs.ventipay.com/reference/checkouts-create
// https://docs.ventipay.com/docs/webhooks

import type {PaymentStatus, RefundStatus} from '../../core/types';

export const VENTI_API = {
    baseUrl: 'https://api.ventipay.com/v1',
    paths: {
        checkouts: '/checkouts',
        checkout: (id: string) => `/checkouts/${id}`,
        cancelCheckout: (id: string) => `/checkouts/${id}/cancel`,
        refundCheckout: (id: string) => `/checkouts/${id}/refund`,
        capturePayment: (id: string) => `/payments/${id}/capture`,
        cancelPayment: (id: string) => `/payments/${id}/cancel`,
        refund: (id: string) => `/refunds/${id}`,
    },
    signatureHeader: 'venti-signature',
} as const;

export type VentiNotificationEvent = 'checkout.created' | 'checkout.paid' | 'checkout.refunded' | 'checkout.canceled';

export interface VentiCheckoutRequest {
    currency: string;
    items: Array<{ name: string; unit_price: number; quantity: number; sku?: string }>;
    external_id: string;
    description: string;
    success_url?: string;
    cancel_url?: string;
    success_url_method?: 'get' | 'post';
    cancel_url_method?: 'get' | 'post';
    metadata?: Record<string, unknown>;
    authorize?: boolean;
    customer_id?: string;
    notification_url?: string;
    notification_events?: VentiNotificationEvent[];
    expires_at?: string;
}

export interface VentiPayment {
    id: string;
    status?: string;
    authorized?: boolean;
    captured?: boolean;
    refunded?: boolean;
    amount?: number;
}

export interface VentiCheckout {
    id: string;
    url: string;
    status?: string;
    external_id?: string;
    amount?: number;
    currency?: string;
    payment_id?: string | null;
    successful_object?: string | null;
    successful_object_id?: string | null;
    refunded?: boolean;
    refunded_amount?: number;
    payment?: VentiPayment | null;
    payment_method?: { type?: string; brand?: string; last4?: string } | null;
    paid_at?: string | null;
    expires_at?: string | null;
}

export interface VentiRefund {
    id: string;
    status: string;
    amount: number;
    checkout_id?: string;
    payment_id?: string;
}

export interface VentiEvent<T = unknown> {
    id: string;
    type: string;
    live?: boolean;
    data: T;
}

export interface VentiErrorResponse {
    type?: string;
    code?: string;
    messages?: string[];
    error?: { type?: string; code?: string; message?: string };
}

/** unpaid · paid · canceled · expired. El reembolso es un booleano aparte. */
export function mapVentiStatus(checkout: VentiCheckout): PaymentStatus {
    switch ((checkout.status ?? '').toLowerCase()) {
        case 'paid':
            return checkout.payment?.status === 'requires_capture' ? 'AUTHORIZED' : 'PAID';
        case 'canceled':
        case 'cancelled':
            return 'CANCELED';
        case 'expired':
            return 'EXPIRED';
        default:
            return 'PENDING';
    }
}

export function mapVentiRefundStatus(status: string): RefundStatus {
    switch (status.toLowerCase()) {
        case 'succeeded':
            return 'SUCCEEDED';
        case 'failed':
            return 'FAILED';
        case 'canceled':
        case 'cancelled':
            return 'CANCELED';
        default:
            return 'PENDING';
    }
}
