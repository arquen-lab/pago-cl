import {invalidInput, returnMismatch} from '../../core/errors';
import {readCurrency} from '../../core/money';
import {bodyParams, queryParams, requestFields} from '../../core/request';
import {
    type Capabilities,
    type CheckoutProduct,
    type CreateResult,
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
    mapMercadoPagoRefundStatus,
    mapMercadoPagoStatus,
    MERCADOPAGO_API,
    type MercadoPagoPaymentResponse,
    type MercadoPagoPreferenceRequest,
    type MercadoPagoPreferenceResponse,
    type MercadoPagoRefundResponse,
    type MercadoPagoSearchResponse,
    type MercadoPagoWebhookBody,
} from './api';
import {type MercadoPagoConfig, MercadoPagoCore} from './core';

/** Campos de Checkout Pro que no están en el checkout común. `raw` va tal cual al body. */
export interface MercadoPagoCheckoutExtras {
    /** `statement_descriptor`, máximo 13 caracteres. */
    statementDescriptor?: string;
    /** `binary_mode`: solo aprobado o rechazado, sin pendientes. */
    binaryMode?: boolean;
    paymentMethods?: {
        excludedPaymentMethodIds?: string[];
        excludedPaymentTypeIds?: string[];
        installments?: number;
    };
    /** Cualquier otro campo de la preferencia, sin mapear. */
    raw?: Record<string, unknown>;
}

export const MERCADOPAGO_CAPABILITIES: Capabilities = {
    currencies: ['CLP'],
    capture: false,
    refund: {partial: true, async: false, windowDays: 180},
    cancel: {unpaid: true, authorized: false},
    notifications: {mode: 'optional', delivery: 'per-request', verification: 'signature'},
    lookupByOrderId: true,
    requires: {},
};

export const MERCADOPAGO_EXTRAS: readonly ExtrasField<ExtrasKey<MercadoPagoCheckoutExtras>>[] = [
    {
        key: 'statementDescriptor',
        type: 'string',
        label: 'statement_descriptor',
        description: 'Texto en el estado de cuenta, máximo 13 caracteres.',
        maxLength: 13
    },
    {
        key: 'binaryMode',
        type: 'boolean',
        label: 'binary_mode',
        description: 'Solo aprobado o rechazado, sin pendientes.'
    },
    {
        key: 'paymentMethods.installments',
        type: 'number',
        label: 'installments',
        description: 'Máximo de cuotas.',
        min: 1
    },
    {
        key: 'paymentMethods.excludedPaymentMethodIds',
        type: 'string[]',
        label: 'excluded_payment_methods',
        description: 'Ids separados por coma, por ejemplo visa,master.'
    },
    {
        key: 'paymentMethods.excludedPaymentTypeIds',
        type: 'string[]',
        label: 'excluded_payment_types',
        description: 'Por ejemplo ticket,atm.'
    },
    {key: 'raw', type: 'json', label: 'raw', description: 'Cualquier otro campo de la preferencia, tal cual.'},
];

export class MercadoPagoCheckout implements CheckoutProduct<MercadoPagoCheckoutExtras> {
    readonly id = 'mercadopago';
    readonly capabilities = MERCADOPAGO_CAPABILITIES;
    readonly extrasSchema = MERCADOPAGO_EXTRAS;
    private readonly core: MercadoPagoCore;

    constructor(config: MercadoPagoConfig) {
        this.core = new MercadoPagoCore(config);
    }

    async create(input: NormalizedCreateInput<MercadoPagoCheckoutExtras>): Promise<CreateResult> {
        if (!input.returnUrl.startsWith('https://')) {
            throw invalidInput('returnUrl', 'Mercado Pago exige returnUrl https y descarta las http.');
        }
        const extras = input.extras;
        const body: MercadoPagoPreferenceRequest = {
            external_reference: input.orderId,
            items: [
                {
                    id: input.orderId,
                    title: input.description,
                    quantity: 1,
                    unit_price: input.amount,
                    currency_id: input.currency,
                },
            ],
            back_urls: {
                success: input.returnUrl,
                failure: input.cancelUrl ?? input.returnUrl,
                pending: input.returnUrl,
            },
            auto_return: 'approved',
            ...(input.notificationUrl ? {notification_url: input.notificationUrl} : {}),
            ...(input.customer ? {payer: this.payer(input)} : {}),
            ...(input.metadata ? {metadata: input.metadata} : {}),
            ...(input.expiresAt
                ? {
                    expires: true,
                    expiration_date_from: new Date().toISOString(),
                    expiration_date_to: input.expiresAt.toISOString(),
                }
                : {}),
            ...(extras?.statementDescriptor ? {statement_descriptor: extras.statementDescriptor} : {}),
            ...(extras?.binaryMode !== undefined ? {binary_mode: extras.binaryMode} : {}),
            ...(extras?.paymentMethods
                ? {
                    payment_methods: {
                        ...(extras.paymentMethods.excludedPaymentMethodIds
                            ? {excluded_payment_methods: extras.paymentMethods.excludedPaymentMethodIds.map((id) => ({id}))}
                            : {}),
                        ...(extras.paymentMethods.excludedPaymentTypeIds
                            ? {excluded_payment_types: extras.paymentMethods.excludedPaymentTypeIds.map((id) => ({id}))}
                            : {}),
                        ...(extras.paymentMethods.installments !== undefined
                            ? {installments: extras.paymentMethods.installments}
                            : {}),
                    },
                }
                : {}),
            ...(extras?.raw ?? {}),
        };
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoPreferenceResponse>(
            'POST',
            MERCADOPAGO_API.paths.preferences,
            {body},
        );
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.id,
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.init_point,
            rawRequest,
            rawResponse,
        };
    }

    /**
     * El retorno trae `payment_id` (o `collection_id`) y `external_reference`.
     * Se consulta el pago y se compara orden y monto; el query no se usa como verdad.
     */
    async handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult> {
        const fields = requestFields(request);
        const externalReference = fields.external_reference?.trim();
        if (externalReference && externalReference !== ref.orderId) {
            throw returnMismatch(this.core.label, `external_reference ${externalReference}`);
        }
        const preferenceId = fields.preference_id?.trim();
        if (preferenceId && preferenceId !== ref.transactionId) {
            throw returnMismatch(this.core.label, `preference_id ${preferenceId}`);
        }
        const paymentId = cleanId(fields.payment_id) ?? cleanId(fields.collection_id);
        if (!paymentId) {
            return this.getStatus(ref);
        }
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoPaymentResponse>(
            'GET',
            MERCADOPAGO_API.paths.payment(paymentId),
        );
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        this.core.verifyNotification(request);
        const body = bodyParams(request) as MercadoPagoWebhookBody;
        const query = queryParams(request);
        const type = body.type ?? query.type ?? query.topic;
        const dataId = body.data?.id !== undefined ? String(body.data.id) : query['data.id'] ?? query.id;
        const eventId = body.id !== undefined ? String(body.id) : undefined;
        if (type !== 'payment' || !dataId) {
            return {eventId, reply: {status: 200}};
        }
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoPaymentResponse>(
            'GET',
            MERCADOPAGO_API.paths.payment(dataId),
        );
        const ref: PaymentRef = {
            provider: this.id,
            orderId: data.external_reference ?? '',
            transactionId: '',
            data: {paymentId: String(data.id)},
        };
        return {
            result: {...this.map(ref, data), rawRequest, rawResponse},
            eventId,
            reply: {status: 200},
        };
    }

    /** Por id de pago si ya se conoce; si no, el pago más reciente de esa orden. */
    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const known = ref.data?.paymentId as string | undefined;
        if (known) {
            const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoPaymentResponse>(
                'GET',
                MERCADOPAGO_API.paths.payment(known),
            );
            return {...this.map(ref, data), rawRequest, rawResponse};
        }
        const search = new URLSearchParams({
            external_reference: ref.orderId,
            sort: 'date_created',
            criteria: 'desc',
        });
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoSearchResponse>(
            'GET',
            `${MERCADOPAGO_API.paths.searchPayments}?${search}`,
        );
        const latest = data.results?.[0];
        if (!latest) {
            return {
                ref,
                status: 'PENDING',
                final: false,
                amount: Number(ref.data?.amount ?? 0),
                currency: readCurrency(ref.data?.currency as string | undefined),
                refundedAmount: 0,
                providerStatus: 'no_payment',
                rawRequest,
                rawResponse,
            };
        }
        return {...this.map(ref, latest), rawRequest, rawResponse};
    }

    async cancel(ref: PaymentRef): Promise<PaymentResult> {
        const current = await this.getStatus(ref);
        const paymentId = current.ref.data?.paymentId as string | undefined;
        if (!paymentId || current.status !== 'PENDING' || current.providerStatus === 'no_payment') {
            throw invalidInput('ref', `Solo se cancela un pago pendiente; este está ${current.status}.`);
        }
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoPaymentResponse>(
            'PUT',
            MERCADOPAGO_API.paths.payment(paymentId),
            {body: {status: 'cancelled'}},
        );
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const paymentId = (ref.data?.paymentId as string | undefined) ?? (await this.getStatus(ref)).ref.data?.paymentId;
        if (!paymentId) throw invalidInput('ref', 'Esta orden no tiene un pago que reembolsar.');
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoRefundResponse>(
            'POST',
            MERCADOPAGO_API.paths.refunds(String(paymentId)),
            {
                body: input.amount !== undefined ? {amount: input.amount} : {},
                headers: {'X-Idempotency-Key': input.refundId},
            },
        );
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: String(data.id), payment: ref},
            status: mapMercadoPagoRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    async getRefund(refund: RefundRef): Promise<RefundResult> {
        const paymentId = refund.payment.data?.paymentId as string | undefined;
        if (!paymentId || !refund.providerRefundId) {
            throw invalidInput('refund', 'La referencia del reembolso necesita el id de pago y el id del reembolso.');
        }
        const {data, rawRequest, rawResponse} = await this.core.request<MercadoPagoRefundResponse>(
            'GET',
            MERCADOPAGO_API.paths.refund(paymentId, refund.providerRefundId),
        );
        return {
            refund,
            status: mapMercadoPagoRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    private map(ref: PaymentRef, data: MercadoPagoPaymentResponse): PaymentResult {
        if (ref.orderId && data.external_reference && data.external_reference !== ref.orderId) {
            throw returnMismatch(this.core.label, `el pago ${data.id} es de la orden ${data.external_reference}`);
        }
        const expected = ref.data?.amount;
        if (typeof expected === 'number' && data.transaction_amount !== expected) {
            throw returnMismatch(this.core.label, `monto ${data.transaction_amount} en vez de ${expected}`);
        }
        const {status, refundedAmount} = mapMercadoPagoStatus(data);
        return {
            ref: {...ref, data: {...ref.data, paymentId: String(data.id)}},
            status,
            final: isFinalStatus(status),
            amount: data.transaction_amount,
            currency: readCurrency(data.currency_id),
            refundedAmount,
            authorizationCode: data.authorization_code,
            paymentMethod: data.payment_method_id,
            providerStatus: data.status_detail ? `${data.status}:${data.status_detail}` : data.status,
        };
    }

    private payer(input: NormalizedCreateInput<MercadoPagoCheckoutExtras>): MercadoPagoPreferenceRequest['payer'] {
        const customer = input.customer ?? {};
        return {
            ...(customer.email ? {email: customer.email.trim()} : {}),
            ...(customer.name ? {name: customer.name.trim()} : {}),
            ...(customer.phone ? {phone: {number: customer.phone.trim()}} : {}),
        };
    }
}

function cleanId(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed !== 'null' && trimmed !== 'undefined' ? trimmed : undefined;
}

export function createMercadoPagoCheckout(config: MercadoPagoConfig): MercadoPagoCheckout {
    return new MercadoPagoCheckout(config);
}
