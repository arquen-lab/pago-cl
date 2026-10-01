// API de órdenes de Klap (Multicaja):
// https://api.pasarela.multicaja.cl/docs/swagger/ecommerce_api_payments.json
// https://api.pasarela.multicaja.cl/docs/swagger/ecommerce_api_payments_tarjetas.json

import type {PaymentStatus} from '../../core/types';

export const KLAP_API = {
    hosts: {
        sandbox: 'https://api-pasarela-sandbox.mcdesaqa.cl',
        production: 'https://api.pasarela.multicaja.cl',
    },
    paths: {
        orders: '/payment-gateway/v1/orders',
        order: (orderId: string) => `/payment-gateway/v1/orders/${orderId}`,
        refund: (orderId: string) => `/payment-gateway/v1/orders/${orderId}/refund`,
        transactions: '/payment-gateway/v1/transactions',
    },
    limits: {
        referenceId: 100,
        webhookUrl: 300,
        minAmount: 50,
        maxAmount: 99_999_999,
    },
    /** Medios que acepta `methods`. `*` habilita todos los contratados. */
    methods: ['tarjetas', 'sodexo', 'edenred'],
    /** Klap exige `<medio>_expiration_minutes` para cada medio de la orden (404007 / 400009 si falta). */
    defaultExpirationMinutes: 30,
} as const;

export interface KlapUser {
    email?: string;
    rut?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
}

export interface KlapOrderRequest {
    reference_id: string;
    user?: KlapUser;
    amount: { currency: string; total: number };
    methods: string[];
    description: string;
    customs?: Array<{ key: string; value: string }>;
    urls: { return_url: string; cancel_url: string };
    webhooks: { webhook_confirm: string; webhook_reject: string; webhook_validation?: string };
}

export interface KlapOrderResponse {
    order_id: string;
    reference_id?: string;
    status: string;
    redirect_url?: string;
    amount?: { currency?: string; total?: number };
    selected_method?: { code?: string; name?: string } | null;
    /** Pares clave-valor (code, message, approval_code, brand, card_type, last_digits...). */
    payment_details?: Array<{ key: string; value: string }> | null;
}

export interface KlapRefundResponse {
    reference_id?: string;
    order_id?: string;
    type?: 'refund' | 'partial_refund';
    amount?: number;
    refundable_amount?: number;
    status?: string;
    mc_code?: string;
}

export interface KlapConfirmNotification {
    order_id: string;
    reference_id: string;
    mc_code?: string;
    amount?: number;
    payment_method?: string;
    card_type?: string;
    last_digits?: string;
    brand?: string;
}

export interface KlapRejectNotification {
    order_id: string;
    reference_id: string;
    code?: string;
    message?: string;
}

export interface KlapErrorResponse {
    code?: string;
    message?: string;
    http_status?: string;
}

/** `payment_details` como mapa. El swagger lo declara string, pero la API devuelve una lista. */
export function klapDetails(data: { payment_details?: unknown }): Record<string, string> {
    const details: Record<string, string> = {};
    if (!Array.isArray(data.payment_details)) return details;
    for (const item of data.payment_details as Array<{ key?: string; value?: unknown }>) {
        if (item?.key && item.value !== undefined && item.value !== null) details[item.key] = String(item.value);
    }
    return details;
}

/** Código con el que Klap marca una reversa automática: el comercio no confirmó el webhook. */
export const KLAP_UNCONFIRMED_REVERSAL = '100100';

/** pending · completed · canceled · expired; `refund` aparece tras una reversa. */
export function mapKlapStatus(status: string, amount: number): { status: PaymentStatus; refundedAmount: number } {
    switch (status.toLowerCase()) {
        case 'completed':
            return {status: 'PAID', refundedAmount: 0};
        case 'canceled':
        case 'cancelled':
            return {status: 'CANCELED', refundedAmount: 0};
        case 'expired':
            return {status: 'EXPIRED', refundedAmount: 0};
        case 'refund':
        case 'refunded':
            return {status: 'PAID', refundedAmount: amount};
        default:
            return {status: 'PENDING', refundedAmount: 0};
    }
}
