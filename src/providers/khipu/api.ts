// API de Pagos Instantáneos v3 de Khipu:
// https://docs.khipu.com/apis/v3/instant-payments/openapi
// https://docs.khipu.com/payment-solutions/instant-payments/payment-webhook

import type {PaymentStatus, RefundStatus} from '../../core/types';

export const KHIPU_API = {
    /** Un solo host: el modo desarrollador es una propiedad de la cuenta de cobro, no del host. */
    baseUrl: 'https://payment-api.khipu.com',
    paths: {
        payments: '/v3/payments',
        payment: (paymentId: string) => `/v3/payments/${paymentId}`,
        refunds: '/v3/refunds',
    },
    notifyApiVersion: '3.0',
    signatureHeader: 'x-khipu-signature',
    limits: {
        subject: 255,
        transactionId: 255,
        url: 1024,
    },
} as const;

export interface KhipuCreateRequest {
    amount: number;
    currency: string;
    subject: string;
    transaction_id?: string;
    custom?: string;
    return_url?: string;
    cancel_url?: string;
    picture_url?: string;
    notify_url?: string;
    notify_api_version?: string;
    expires_date?: string;
    send_email?: boolean;
    payer_name?: string;
    payer_email?: string;
    send_reminders?: boolean;
    bank_id?: string;
    fixed_payer_personal_identifier?: string;
    mandatory_payment_method?: string;
}

export interface KhipuCreateResponse {
    payment_id: string;
    payment_url: string;
    simplified_transfer_url?: string;
    transfer_url?: string;
    app_url?: string;
    ready_for_terminal?: boolean;
}

export interface KhipuRefundItem {
    id: string;
    status: string;
    amount: string | number;
    currency: string;
    request_date?: string;
}

export interface KhipuPayment extends Partial<KhipuCreateResponse> {
    payment_id: string;
    /** `pending` · `verifying` · `done`; un cobro borrado queda `deleted`. No existe un estado de expiración. */
    status?: string;
    status_detail?: string;
    amount?: string | number;
    currency?: string;
    transaction_id?: string;
    subject?: string;
    bank?: string;
    payment_method?: string;
    funds_source?: string;
    authorizer_operation_code?: string;
    conciliation_date?: string;
    expires_date?: string;
    refunds?: KhipuRefundItem[];
    total_refunded?: string | number;
    void_payout_date?: string;
}

export interface KhipuRefundResponse {
    id: string;
    payment_id: string;
    refunded_amount: string;
    total_refunded: string;
    remaining: string;
    currency: string;
    message?: string;
}

/** Evento de conciliación (API de notificaciones 3.0): un subconjunto del pago. */
export interface KhipuNotification {
    payment_id: string;
    transaction_id?: string;
    amount?: string | number;
    currency?: string;
    bank?: string;
    payment_method?: string;
    authorizer_operation_code?: string;
    conciliation_date?: string;
    out_of_date_conciliation?: boolean;
}

export interface KhipuErrorResponse {
    message?: string;
    error?: string;
    status?: number;
    type?: string;
    code?: string;
    errors?: Array<{ message?: string; field?: string }>;
}

/**
 * `done` es el único estado final del pago. El detalle dice cómo terminó. Un cobro `pending`
 * que pasó su `expires_date` se informa EXPIRED (Khipu no tiene un estado propio para eso).
 */
export function mapKhipuStatus(
    payment: Pick<KhipuPayment, 'status' | 'status_detail' | 'amount' | 'total_refunded' | 'expires_date'>,
    now = Date.now(),
): { status: PaymentStatus; refundedAmount: number } {
    const amount = Number(payment.amount ?? 0);
    const refunded = Number(payment.total_refunded ?? 0);
    switch ((payment.status ?? '').toLowerCase()) {
        case 'done':
            switch ((payment.status_detail ?? '').toLowerCase()) {
                case 'rejected-by-payer':
                case 'marked-as-abuse':
                    return {status: 'REJECTED', refundedAmount: 0};
                case 'reversed':
                    return {status: 'PAID', refundedAmount: amount};
                case 'fully-refunded':
                    return {status: 'PAID', refundedAmount: refunded || amount};
                default:
                    // normal, marked-paid-by-receiver y partially-refunded
                    return {status: 'PAID', refundedAmount: refunded};
            }
        case 'verifying':
            return {status: 'PENDING', refundedAmount: 0};
        case 'deleted':
            // Un cobro borrado con DELETE sigue consultable con este estado, que el OpenAPI no lista.
            return {status: 'CANCELED', refundedAmount: 0};
        default: {
            const expires = payment.expires_date ? Date.parse(payment.expires_date) : NaN;
            return {status: Number.isFinite(expires) && expires < now ? 'EXPIRED' : 'PENDING', refundedAmount: 0};
        }
    }
}

/** Estados de una devolución: pending, authorized (Khipu responde), paid (fondos entregados), expired. */
export function mapKhipuRefundStatus(status: string): RefundStatus {
    switch (status.toLowerCase()) {
        case 'paid':
            return 'SUCCEEDED';
        case 'expired':
            return 'FAILED';
        default:
            return 'PENDING';
    }
}
