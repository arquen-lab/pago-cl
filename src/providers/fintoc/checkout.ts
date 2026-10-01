import {invalidInput, returnMismatch} from '../../core/errors';
import {readCurrency} from '../../core/money';
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
    FINTOC_API,
    FINTOC_PAYMENT_METHOD_TYPES,
    type FintocCheckoutSession,
    type FintocCheckoutSessionRequest,
    type FintocEvent,
    type FintocRefund,
    mapFintocRefundStatus,
    mapFintocSession,
} from './api';
import {type FintocConfig, FintocCore} from './core';

/** Campos de Fintoc Checkout que no están en el checkout común. */
export interface FintocCheckoutExtras {
    /** `payment_method_types`. Si falta, valen los de tu cuenta. */
    paymentMethodTypes?: Array<(typeof FINTOC_PAYMENT_METHOD_TYPES)[number]>;
}

export const FINTOC_EXTRAS: readonly ExtrasField<ExtrasKey<FintocCheckoutExtras>>[] = [
    {
        key: 'paymentMethodTypes',
        type: 'multiselect',
        label: 'payment_method_types',
        description: 'Medios que verá el pagador. Vacío = los de tu cuenta.',
        options: FINTOC_PAYMENT_METHOD_TYPES,
    },
];

export const FINTOC_CAPABILITIES: Capabilities = {
    currencies: ['CLP'],
    capture: false,
    // La devolución sale por transferencia: procesa a las 18:00 del día hábil y llega en 1 a 2 días.
    refund: {partial: true, async: true},
    cancel: {unpaid: true, authorized: false},
    // Los webhooks se registran en la cuenta (panel o API), no en cada pago.
    notifications: {mode: 'optional', delivery: 'account-api', verification: 'signature'},
    lookupByOrderId: false,
    requires: {create: []},
};

export class FintocCheckout implements CheckoutProduct<FintocCheckoutExtras> {
    readonly id = 'fintoc';
    readonly capabilities = FINTOC_CAPABILITIES;
    readonly extrasSchema = FINTOC_EXTRAS;
    private readonly core: FintocCore;

    constructor(config: FintocConfig) {
        this.core = new FintocCore(config);
    }

    async create(input: NormalizedCreateInput<FintocCheckoutExtras>): Promise<CreateResult> {
        if (input.expiresAt && input.expiresAt.getTime() - Date.now() < FINTOC_API.minExpirationMinutes * 60_000) {
            throw invalidInput('expiresAt', `Fintoc exige al menos ${FINTOC_API.minExpirationMinutes} minutos de vigencia.`);
        }
        const types = input.extras?.paymentMethodTypes;
        const body: FintocCheckoutSessionRequest = {
            currency: input.currency,
            amount: input.amount,
            success_url: input.returnUrl,
            cancel_url: input.cancelUrl ?? input.returnUrl,
            ...(input.customer?.email ? {customer_email: input.customer.email.trim()} : {}),
            ...(input.expiresAt ? {expires_at: input.expiresAt.toISOString()} : {}),
            // El id de orden no tiene campo propio: va en metadata y se verifica al consultar.
            metadata: {...input.metadata, [FINTOC_API.orderIdMetadataKey]: input.orderId},
            ...(types?.length ? {payment_method_types: types} : {}),
        };
        const {data, rawRequest, rawResponse} = await this.core.request<FintocCheckoutSession>(
            'POST',
            FINTOC_API.paths.checkoutSessions,
            body,
        );
        if (!data.id || !data.redirect_url) {
            throw invalidInput('response', 'Fintoc no devolvió id ni redirect_url de la sesión.');
        }
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.id,
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.redirect_url,
            rawRequest,
            rawResponse,
        };
    }

    /** `success_url` y `cancel_url` no traen datos documentados: el resultado sale de la consulta. */
    async handleReturn(ref: PaymentRef, _request: IncomingRequest): Promise<PaymentResult> {
        return this.getStatus(ref);
    }

    /**
     * Eventos firmados con el secreto del webhook endpoint. `checkout_session.*` trae la sesión
     * (y en ella el id de orden); `refund.*` trae la devolución. Los `payment_intent.*` no llevan
     * el id de orden: se responde 200 y el estado final llega con la sesión.
     */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        this.core.verifyNotification(request);
        let event: FintocEvent;
        try {
            event = JSON.parse(request.body ?? '') as FintocEvent;
        } catch {
            return {reply: {status: 400, body: 'cuerpo no es JSON'}};
        }
        const reply = {status: 200, body: '{"received":true}', headers: {'content-type': 'application/json'}};
        if (event.type.startsWith('checkout_session.')) {
            const session = event.data as FintocCheckoutSession;
            const orderId = session.metadata?.[FINTOC_API.orderIdMetadataKey];
            if (!orderId) return {eventId: event.id, reply};
            const ref: PaymentRef = {provider: this.id, orderId, transactionId: session.id};
            return {result: {...this.map(ref, session), rawResponse: event}, eventId: event.id, reply};
        }
        if (event.type.startsWith('refund.')) {
            const refund = event.data as FintocRefund;
            return {
                refund: {
                    refund: {
                        provider: this.id,
                        refundId: refund.metadata?.refund_id ?? refund.id,
                        providerRefundId: refund.id,
                        payment: {
                            provider: this.id,
                            orderId: '',
                            transactionId: '',
                            data: {paymentIntentId: refund.resource_id}
                        },
                    },
                    status: mapFintocRefundStatus(refund.status),
                    amount: refund.amount,
                    providerStatus: refund.status,
                    ...(refund.failure_code ? {statusDetail: refund.failure_code} : {}),
                    rawResponse: event,
                },
                eventId: event.id,
                reply,
            };
        }
        return {eventId: event.id, reply};
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.fetchSession(ref.transactionId);
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    /** `POST /v2/checkout_sessions/{id}/expire`: solo mientras la sesión está `created`. */
    async cancel(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.core.request<FintocCheckoutSession>(
            'POST',
            FINTOC_API.paths.expireCheckoutSession(ref.transactionId),
        );
        return {
            ...this.map(ref, data),
            status: 'CANCELED',
            final: true,
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    /**
     * `POST /v1/refunds` sobre el `payment_intent` del pago (no la sesión): se aprende al consultar.
     * La devolución es una transferencia: nace `created` y se procesa a las 18:00 del día hábil.
     */
    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const intentId = (ref.data?.paymentIntentId as string | undefined) ?? (await this.getStatus(ref)).ref.data?.paymentIntentId;
        if (typeof intentId !== 'string') {
            throw invalidInput('ref', 'Esta sesión no tiene un pago que reembolsar (aún no hay payment_intent).');
        }
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<FintocRefund>('POST', FINTOC_API.paths.refunds, {
            resource_id: intentId,
            resource_type: 'payment_intent',
            ...(input.amount !== undefined ? {amount: input.amount} : {}),
            metadata: {refund_id: input.refundId},
        });
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: data.id, payment: ref},
            status: mapFintocRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            ...(data.failure_code ? {statusDetail: data.failure_code} : {}),
            rawRequest,
            rawResponse,
        };
    }

    async getRefund(refund: RefundRef): Promise<RefundResult> {
        if (!refund.providerRefundId) throw invalidInput('refund', 'Falta providerRefundId.');
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<FintocRefund>('GET', FINTOC_API.paths.refund(refund.providerRefundId));
        return {
            refund,
            status: mapFintocRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            ...(data.failure_code ? {statusDetail: data.failure_code} : {}),
            rawRequest,
            rawResponse,
        };
    }

    private fetchSession(id: string) {
        return this.core.request<FintocCheckoutSession>('GET', FINTOC_API.paths.checkoutSession(id));
    }

    private map(ref: PaymentRef, session: FintocCheckoutSession): PaymentResult {
        const orderId = session.metadata?.[FINTOC_API.orderIdMetadataKey];
        if (ref.orderId && orderId && orderId !== ref.orderId) {
            throw returnMismatch(this.core.label, `la sesión ${session.id} es de la orden ${orderId}`);
        }
        const intent = session.payment_resource?.payment_intent;
        const {status, detail} = mapFintocSession(session);
        const amount = session.amount ?? Number(ref.data?.amount ?? 0);
        const currency = readCurrency(session.currency, readCurrency(ref.data?.currency as string | undefined));
        const method = [intent?.payment_type, intent?.sender_account?.institution_id].filter(Boolean).join(' ');
        return {
            ref: {
                ...ref,
                data: {...ref.data, amount, currency, ...(intent?.id ? {paymentIntentId: intent.id} : {})},
            },
            status,
            final: isFinalStatus(status),
            amount,
            currency,
            refundedAmount: 0,
            authorizationCode: intent?.reference_id ?? undefined,
            paymentMethod: method || undefined,
            providerStatus: intent ? `${session.status}:${intent.status}` : session.status,
            ...(detail ? {statusDetail: detail} : {}),
        };
    }
}

export function createFintocCheckout(config: FintocConfig): FintocCheckout {
    return new FintocCheckout(config);
}
