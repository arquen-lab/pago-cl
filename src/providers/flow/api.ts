// https://developers.flow.cl/api  (OpenAPI: https://developers.flow.cl/es-openApiFlow.yaml)
// https://developers.flow.cl/docs/tutorial-basics/order-confirmation

import type {PaymentStatus, RefundStatus} from '../../core/types';

export const FLOW_API = {
    hosts: {
        sandbox: 'https://sandbox.flow.cl/api',
        production: 'https://www.flow.cl/api',
    },
    paths: {
        createPayment: '/payment/create',
        getStatus: '/payment/getStatus',
        getStatusByCommerceId: '/payment/getStatusByCommerceId',
        getStatusByFlowOrder: '/payment/getStatusByFlowOrder',
        createRefund: '/refund/create',
        refundStatus: '/refund/getStatus',
    },
    contentType: 'application/x-www-form-urlencoded',
} as const;

/** 1 pendiente · 2 pagada · 3 rechazada · 4 anulada */
export const FLOW_PAYMENT_STATUS = {
    1: 'PENDING',
    2: 'PAID',
    3: 'REJECTED',
    4: 'CANCELED',
} as const satisfies Record<number, PaymentStatus>;

export const FLOW_REFUND_STATUS = {
    created: 'PENDING',
    accepted: 'PENDING',
    refunded: 'SUCCEEDED',
    rejected: 'FAILED',
    canceled: 'CANCELED',
} as const satisfies Record<string, RefundStatus>;

export type FlowParams = Record<string, string | number | undefined>;

export interface FlowCreatePaymentResponse {
    url: string;
    token: string;
    flowOrder: number;
}

export interface FlowStatusResponse {
    flowOrder: number;
    commerceOrder: string;
    requestDate?: string;
    status: number;
    subject?: string;
    currency?: string;
    amount: number;
    payer?: string;
    optional?: string;
    pending_info?: { media?: string; date?: string };
    paymentData?: {
        date?: string;
        media?: string;
        conversionDate?: string;
        conversionRate?: number;
        amount?: number;
        currency?: string;
        fee?: number;
        balance?: number;
        transferDate?: string;
    };
    merchantId?: string;
}

export interface FlowRefundResponse {
    token: string;
    flowRefundOrder: number;
    date?: string;
    status: string;
    amount: number;
    fee?: number;
}

export interface FlowErrorResponse {
    code?: number | string;
    message?: string;
}

export function mapFlowStatus(status: number): PaymentStatus {
    return FLOW_PAYMENT_STATUS[status as keyof typeof FLOW_PAYMENT_STATUS] ?? 'PENDING';
}

export function mapFlowRefundStatus(status: string): RefundStatus {
    return FLOW_REFUND_STATUS[status as keyof typeof FLOW_REFUND_STATUS] ?? 'PENDING';
}

export function flowRedirectUrl(response: FlowCreatePaymentResponse): string {
    return `${response.url}?token=${response.token}`;
}
