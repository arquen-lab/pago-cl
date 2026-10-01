import {invalidInput, returnMismatch} from '../../core/errors';
import {fromMinorUnits, readCurrency, toMinorUnits} from '../../core/money';
import {requestFields} from '../../core/request';
import {
    type Capabilities,
    type CheckoutProduct,
    type CreateResult,
    type Currency,
    type ExtrasField,
    type ExtrasKey,
    type IncomingRequest,
    isFinalStatus,
    type NormalizedCreateInput,
    type NotificationResult,
    type PaymentRef,
    type PaymentResult,
    type RefundInput,
    type RefundRef,
    type RefundResult,
} from '../../core/types';
import {
    mapVentiRefundStatus,
    mapVentiStatus,
    VENTI_API,
    type VentiCheckout,
    type VentiCheckoutRequest,
    type VentiNotificationEvent,
    type VentiPayment,
    type VentiRefund,
} from './api';
import {type VentiConfig, VentiCore} from './core';

/** Campos del checkout de Venti que no están en el checkout común. */
export interface VentiCheckoutExtras {
    /** `customer_id` de un cliente ya creado en Venti. */
    customerId?: string;
    /** `items[].sku` del único ítem. */
    sku?: string;
    /** `notification_events`. Por defecto todos los del checkout. */
    notificationEvents?: VentiNotificationEvent[];
}

export const VENTI_CAPABILITIES: Capabilities = {
    currencies: ['CLP', 'UF'],
    capture: {partial: false, windowMinutes: 10},
    refund: {partial: true, async: true},
    cancel: {unpaid: true, authorized: true},
    notifications: {mode: 'optional', delivery: 'per-request', verification: 'signature'},
    lookupByOrderId: true,
    requires: {},
};

const ALL_EVENTS: VentiNotificationEvent[] = ['checkout.created', 'checkout.paid', 'checkout.refunded', 'checkout.canceled'];

export const VENTI_EXTRAS: readonly ExtrasField<ExtrasKey<VentiCheckoutExtras>>[] = [
    {key: 'customerId', type: 'string', label: 'customer_id', description: 'Cliente ya creado en Venti (cus_...).'},
    {key: 'sku', type: 'string', label: 'sku', description: 'SKU del único ítem.'},
    {
        key: 'notificationEvents',
        type: 'multiselect',
        label: 'notification_events',
        description: 'Por defecto todos.',
        options: ALL_EVENTS
    },
];

export class VentiCheckoutProduct implements CheckoutProduct<VentiCheckoutExtras> {
    readonly id = 'venti';
    readonly capabilities = VENTI_CAPABILITIES;
    readonly extrasSchema = VENTI_EXTRAS;
    private readonly core: VentiCore;

    constructor(config: VentiConfig) {
        this.core = new VentiCore(config);
    }

    async create(input: NormalizedCreateInput<VentiCheckoutExtras>): Promise<CreateResult> {
        const extras = input.extras;
        const body: VentiCheckoutRequest = {
            currency: input.currency === 'UF' ? 'clf' : 'clp',
            items: [
                {
                    name: input.description,
                    unit_price: toMinorUnits(input.amount, input.currency),
                    quantity: 1,
                    ...(extras?.sku ? {sku: extras.sku} : {}),
                },
            ],
            external_id: input.orderId,
            description: input.description,
            success_url: input.returnUrl,
            cancel_url: input.cancelUrl ?? input.returnUrl,
            success_url_method: 'get',
            cancel_url_method: 'get',
            ...(input.metadata ? {metadata: input.metadata} : {}),
            ...(input.capture === 'manual' ? {authorize: false} : {}),
            ...(extras?.customerId ? {customer_id: extras.customerId} : {}),
            ...(input.notificationUrl
                ? {
                    notification_url: input.notificationUrl,
                    notification_events: extras?.notificationEvents ?? ALL_EVENTS
                }
                : {}),
            ...(input.expiresAt ? {expires_at: input.expiresAt.toISOString()} : {}),
        };
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<VentiCheckout>('POST', VENTI_API.paths.checkouts, {
            body,
        });
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.id,
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.url,
            rawRequest,
            rawResponse,
        };
    }

    /** Venti no documenta parámetros de retorno: el resultado sale de la consulta. */
    async handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult> {
        const externalId = requestFields(request).external_id?.trim();
        if (externalId && externalId !== ref.orderId) {
            throw returnMismatch(this.core.label, `external_id ${externalId}`);
        }
        return this.getStatus(ref);
    }

    /** Evento firmado con el objeto completo. `checkout.*` da resultado; `refund.*` da reembolso. */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        const event = this.core.verifyNotification(request);
        const type = event.type ?? '';
        if (type.startsWith('checkout.')) {
            const checkout = event.data as VentiCheckout;
            const ref: PaymentRef = {
                provider: this.id,
                orderId: checkout.external_id ?? '',
                transactionId: checkout.id,
            };
            return {result: this.map(ref, checkout), eventId: event.id, reply: {status: 200}};
        }
        if (type.startsWith('refund.')) {
            const refund = event.data as VentiRefund;
            return {
                refund: {
                    refund: {
                        provider: this.id,
                        refundId: refund.id,
                        providerRefundId: refund.id,
                        payment: {provider: this.id, orderId: '', transactionId: refund.checkout_id ?? ''},
                    },
                    status: mapVentiRefundStatus(refund.status),
                    amount: fromMinorUnits(refund.amount, 'CLP'),
                    providerStatus: refund.status,
                },
                eventId: event.id,
                reply: {status: 200},
            };
        }
        return {eventId: event.id, reply: {status: 200}};
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.fetchCheckout(ref.transactionId);
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    async capture(ref: PaymentRef, amount?: number): Promise<PaymentResult> {
        if (amount !== undefined) {
            throw invalidInput('amount', 'Venti captura solo el monto total autorizado.');
        }
        const {data: checkout} = await this.fetchCheckout(ref.transactionId);
        const paymentId = checkout.payment_id ?? checkout.payment?.id;
        if (!paymentId || checkout.payment?.status !== 'requires_capture') {
            throw invalidInput('ref', 'Este checkout no tiene un pago autorizado pendiente de captura.');
        }
        const {
            rawRequest,
            rawResponse
        } = await this.core.request<VentiPayment>('POST', VENTI_API.paths.capturePayment(paymentId));
        const after = await this.fetchCheckout(ref.transactionId);
        return {...this.map(ref, after.data), rawRequest, rawResponse};
    }

    async cancel(ref: PaymentRef): Promise<PaymentResult> {
        const {data: checkout} = await this.fetchCheckout(ref.transactionId);
        const paymentId = checkout.payment_id ?? checkout.payment?.id;
        const path =
            checkout.payment?.status === 'requires_capture' && paymentId
                ? VENTI_API.paths.cancelPayment(paymentId)
                : (checkout.status ?? '') === 'unpaid'
                    ? VENTI_API.paths.cancelCheckout(ref.transactionId)
                    : undefined;
        if (!path) {
            throw invalidInput('ref', `No se puede cancelar un checkout ${checkout.status ?? 'desconocido'}.`);
        }
        const {rawRequest, rawResponse} = await this.core.request<unknown>('POST', path);
        const after = await this.fetchCheckout(ref.transactionId);
        return {...this.map(ref, after.data), rawRequest, rawResponse};
    }

    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const currency = this.refCurrency(ref);
        const {data, rawRequest, rawResponse} = await this.core.request<VentiRefund>(
            'POST',
            VENTI_API.paths.refundCheckout(ref.transactionId),
            {
                body: {
                    destination: 'payment_method',
                    ...(input.amount !== undefined ? {amount: toMinorUnits(input.amount, currency)} : {}),
                },
                idempotencyKey: input.refundId,
            },
        );
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: data.id, payment: ref},
            status: mapVentiRefundStatus(data.status),
            amount: fromMinorUnits(data.amount, currency),
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    async getRefund(refund: RefundRef): Promise<RefundResult> {
        if (!refund.providerRefundId) throw invalidInput('refund', 'Falta providerRefundId.');
        const currency = this.refCurrency(refund.payment);
        const {data, rawRequest, rawResponse} = await this.core.request<VentiRefund>(
            'GET',
            VENTI_API.paths.refund(refund.providerRefundId),
        );
        return {
            refund,
            status: mapVentiRefundStatus(data.status),
            amount: fromMinorUnits(data.amount, currency),
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    private fetchCheckout(id: string) {
        const query = new URLSearchParams();
        query.append('expand[]', 'payment');
        query.append('expand[]', 'payment_method');
        return this.core.request<VentiCheckout>('GET', `${VENTI_API.paths.checkout(id)}?${query}`);
    }

    private map(ref: PaymentRef, data: VentiCheckout): PaymentResult {
        if (ref.orderId && data.external_id && data.external_id !== ref.orderId) {
            throw returnMismatch(this.core.label, `external_id ${data.external_id}`);
        }
        const currency = readCurrency(data.currency, this.refCurrency(ref));
        const status = mapVentiStatus(data);
        const method = data.payment_method;
        return {
            ref: {
                ...ref,
                data: {
                    ...ref.data,
                    currency,
                    ...(data.payment_id ? {paymentId: data.payment_id} : {}),
                },
            },
            status,
            final: isFinalStatus(status),
            amount: data.amount !== undefined ? fromMinorUnits(data.amount, currency) : Number(ref.data?.amount ?? 0),
            currency,
            refundedAmount: data.refunded_amount !== undefined
                ? fromMinorUnits(data.refunded_amount, currency)
                : data.refunded && data.amount !== undefined
                    ? fromMinorUnits(data.amount, currency)
                    : 0,
            authorizationCode: data.successful_object_id ?? data.payment_id ?? undefined,
            paymentMethod: method ? [method.brand ?? method.type, method.last4].filter(Boolean).join(' ') || undefined : data.successful_object ?? undefined,
            providerStatus: data.payment?.status ? `${data.status}:${data.payment.status}` : (data.status ?? ''),
        };
    }

    private refCurrency(ref: PaymentRef): Currency {
        return readCurrency(ref.data?.currency as string | undefined);
    }
}

export function createVentiCheckout(config: VentiConfig): VentiCheckoutProduct {
    return new VentiCheckoutProduct(config);
}
