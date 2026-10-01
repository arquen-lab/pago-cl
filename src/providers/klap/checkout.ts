import {invalidInput, missingField, returnMismatch} from '../../core/errors';
import {readCurrency} from '../../core/money';
import {bodyParams, queryParams} from '../../core/request';
import {isLocalUrl} from '../../core/url';
import {
    type Capabilities,
    type CheckoutProduct,
    type CreateResult,
    type ExtrasField,
    type ExtrasKey,
    type HttpReply,
    type IncomingRequest,
    isFinalStatus,
    type NormalizedCreateInput,
    type NotificationResult,
    type PaymentRef,
    type PaymentResult,
    type RefundInput,
    type RefundResult,
} from '../../core/types';
import {
    KLAP_API,
    KLAP_UNCONFIRMED_REVERSAL,
    type KlapConfirmNotification,
    klapDetails,
    type KlapOrderRequest,
    type KlapOrderResponse,
    type KlapRefundResponse,
    type KlapRejectNotification,
    mapKlapStatus,
} from './api';
import {type KlapConfig, KlapCore} from './core';

/** Campos de Klap Checkout que no están en el checkout común. */
export interface KlapCheckoutExtras {
    /** `methods`. Por defecto `['*']`: todos los medios contratados. */
    methods?: string[];
    /** `tarjetas_quotas_allowed`: cuotas permitidas, por ejemplo `5` o `2-6`. */
    quotasAllowed?: string;
    /** `customs`: pares clave-valor sin mapear (`notify_payment_user`, etc.). */
    customs?: Record<string, string>;
    /**
     * `webhook_reject`. Por defecto es `notificationUrl` con `?kind=reject`.
     * Ponla si los rechazos llegan a otro endpoint; el SDK le agrega igual `?kind=reject`.
     */
    rejectNotificationUrl?: string;
}

export const KLAP_EXTRAS: readonly ExtrasField<ExtrasKey<KlapCheckoutExtras>>[] = [
    {key: 'methods', type: 'string[]', label: 'methods', description: 'tarjetas, sodexo, edenred. Vacío = todos (*).'},
    {
        key: 'quotasAllowed',
        type: 'string',
        label: 'tarjetas_quotas_allowed',
        description: 'Cuotas permitidas: 5 o un rango como 2-6.'
    },
    {
        key: 'rejectNotificationUrl',
        type: 'string',
        label: 'webhook_reject',
        description: 'Webhook de rechazo. Vacío = la misma notificationUrl con ?kind=reject.'
    },
    {
        key: 'customs',
        type: 'json',
        label: 'customs',
        description: 'Otros pares de customs, por ejemplo notify_payment_user.'
    },
];

export const KLAP_CAPABILITIES: Capabilities = {
    currencies: ['CLP'],
    capture: false,
    refund: {partial: true, async: false},
    cancel: {unpaid: false, authorized: false},
    notifications: {mode: 'required', delivery: 'per-request', verification: 'signature'},
    lookupByOrderId: true,
    requires: {create: []},
};

/** Respuesta que Klap exige a los webhooks: 2xx con cuerpo JSON, en menos de 10 segundos. */
const ACK: HttpReply = {status: 200, body: '{"status":"ok"}', headers: {'content-type': 'application/json'}};

export class KlapCheckout implements CheckoutProduct<KlapCheckoutExtras> {
    readonly id = 'klap';
    readonly capabilities = KLAP_CAPABILITIES;
    readonly extrasSchema = KLAP_EXTRAS;
    private readonly core: KlapCore;

    constructor(config: KlapConfig) {
        this.core = new KlapCore(config);
    }

    async create(input: NormalizedCreateInput<KlapCheckoutExtras>): Promise<CreateResult> {
        if (input.amount < KLAP_API.limits.minAmount || input.amount > KLAP_API.limits.maxAmount) {
            throw invalidInput('amount', `Klap admite montos entre ${KLAP_API.limits.minAmount} y ${KLAP_API.limits.maxAmount} CLP.`);
        }
        const confirm = this.core.notificationUrl('confirm', input.notificationUrl);
        const reject = this.core.notificationUrl('reject', input.extras?.rejectNotificationUrl ?? input.notificationUrl);
        if (!confirm || !reject) throw missingField('notificationUrl', this.core.label);
        for (const url of [confirm, reject]) {
            if (isLocalUrl(url)) {
                throw invalidInput(
                    url === reject && input.extras?.rejectNotificationUrl ? 'extras.rejectNotificationUrl' : 'notificationUrl',
                    'Klap confirma el pago con el webhook y lo entrega desde internet: con una URL local no llega y Klap reversa el cargo. Usa una URL pública (por ejemplo un túnel).',
                );
            }
            if (url.length > KLAP_API.limits.webhookUrl) {
                throw invalidInput('notificationUrl', `Klap admite webhooks de hasta ${KLAP_API.limits.webhookUrl} caracteres.`);
            }
        }
        const extras = input.extras;
        const methods = extras?.methods?.length ? extras.methods : ['*'];
        const customs = this.customs(input, methods);
        const user = this.user(input);
        const body: KlapOrderRequest = {
            reference_id: input.orderId,
            ...(user ? {user} : {}),
            amount: {currency: input.currency, total: input.amount},
            methods,
            description: input.description,
            ...(customs.length > 0 ? {customs} : {}),
            urls: {return_url: input.returnUrl, cancel_url: input.cancelUrl ?? input.returnUrl},
            webhooks: {webhook_confirm: confirm, webhook_reject: reject},
        };
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<KlapOrderResponse>('POST', KLAP_API.paths.orders, body);
        if (!data.order_id || !data.redirect_url) {
            throw invalidInput('response', 'Klap no devolvió order_id ni redirect_url.');
        }
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.order_id,
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.redirect_url,
            rawRequest,
            rawResponse,
        };
    }

    /** `return_url` y `cancel_url` no traen datos documentados: el resultado sale de la consulta. */
    async handleReturn(ref: PaymentRef, _request: IncomingRequest): Promise<PaymentResult> {
        return this.getStatus(ref);
    }

    /**
     * El webhook de confirmación ES el commit: sin una respuesta 2xx con JSON en 10 segundos
     * Klap reversa el pago. Por eso el resultado se arma desde el evento verificado y no
     * desde la consulta (la orden sigue `pending` hasta que se responde).
     */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        const kind = queryParams(request).kind;
        const body = bodyParams(request) as Record<string, unknown>;
        const orderId = typeof body.order_id === 'string' ? body.order_id : '';
        const referenceId = typeof body.reference_id === 'string' ? body.reference_id : '';
        if (!orderId || !referenceId || (kind !== 'confirm' && kind !== 'reject')) {
            return {reply: {status: 400, body: '{"error":"notificación incompleta"}', headers: ACK.headers}};
        }
        this.core.verifyNotification(request, referenceId, orderId);
        const ref: PaymentRef = {provider: this.id, orderId: referenceId, transactionId: orderId};

        if (kind === 'reject') {
            const reject = body as unknown as KlapRejectNotification;
            return {
                result: {
                    ref,
                    status: 'REJECTED',
                    final: true,
                    amount: 0,
                    currency: 'CLP',
                    refundedAmount: 0,
                    providerStatus: `rejected${reject.code ? `:${reject.code}` : ''}`,
                    rawResponse: reject,
                },
                eventId: `reject:${orderId}`,
                reply: ACK,
            };
        }

        const confirm = body as unknown as KlapConfirmNotification;
        const amount = await this.confirmedAmount(orderId, confirm.amount);
        return {
            result: {
                ref: {...ref, data: {amount, currency: 'CLP'}},
                status: 'PAID',
                final: true,
                amount,
                currency: 'CLP',
                refundedAmount: 0,
                authorizationCode: confirm.mc_code,
                paymentMethod: [confirm.brand, confirm.card_type, confirm.last_digits].filter(Boolean).join(' ') || confirm.payment_method,
                providerStatus: 'confirmed',
                rawResponse: confirm,
            },
            eventId: `confirm:${orderId}`,
            reply: ACK,
        };
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<KlapOrderResponse>('GET', KLAP_API.paths.order(ref.transactionId));
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    /** Sin monto: reembolso total. Con monto menor: parcial. Síncrono. */
    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const {data, rawRequest, rawResponse} = await this.core.request<KlapRefundResponse>(
            'POST',
            KLAP_API.paths.refund(ref.transactionId),
            input.amount !== undefined ? {amount: input.amount} : {},
        );
        const done = ['refunded', 'completed', 'succeeded'].includes((data.status ?? '').toLowerCase());
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: data.mc_code, payment: ref},
            status: done ? 'SUCCEEDED' : 'PENDING',
            amount: data.amount ?? input.amount ?? Number(ref.data?.amount ?? 0),
            refundableAmount: data.refundable_amount,
            providerStatus: data.type ? `${data.status}:${data.type}` : data.status,
            rawRequest,
            rawResponse,
        };
    }

    /** El monto sale del evento si viene; si no, de la orden. Nunca debe impedir responder el ACK. */
    private async confirmedAmount(orderId: string, fromEvent: number | undefined): Promise<number> {
        if (fromEvent !== undefined) return fromEvent;
        try {
            const {data} = await this.core.request<KlapOrderResponse>('GET', KLAP_API.paths.order(orderId));
            return data.amount?.total ?? 0;
        } catch {
            return 0;
        }
    }

    private map(ref: PaymentRef, data: KlapOrderResponse): PaymentResult {
        if (ref.orderId && data.reference_id && data.reference_id !== ref.orderId) {
            throw returnMismatch(this.core.label, `reference_id ${data.reference_id}`);
        }
        const amount = data.amount?.total ?? Number(ref.data?.amount ?? 0);
        const details = klapDetails(data);
        const mapped = mapKlapStatus(data.status ?? '', amount);
        // La orden aprobada que el comercio no confirmó se reversa sola (código 100100): no hubo venta.
        const unconfirmed = (data.status ?? '').toLowerCase() === 'refund' && details.code === KLAP_UNCONFIRMED_REVERSAL;
        const status = unconfirmed ? 'CANCELED' : mapped.status;
        const card = [details.brand, details.card_type, details.last_digits].filter(Boolean).join(' ');
        return {
            ref: {...ref, data: {...ref.data, amount, currency: 'CLP'}},
            status,
            final: isFinalStatus(status),
            amount,
            currency: readCurrency(data.amount?.currency),
            refundedAmount: unconfirmed ? 0 : mapped.refundedAmount,
            authorizationCode: details.approval_code,
            paymentMethod: card || data.selected_method?.name,
            providerStatus: details.code ? `${data.status}:${details.code}` : (data.status ?? ''),
            ...(details.message ? {statusDetail: details.message} : {}),
        };
    }

    private user(input: NormalizedCreateInput<KlapCheckoutExtras>): KlapOrderRequest['user'] | undefined {
        const customer = input.customer;
        if (!customer) return undefined;
        const [first, ...rest] = (customer.name ?? '').trim().split(/\s+/).filter(Boolean);
        const user = {
            ...(customer.email ? {email: customer.email.trim()} : {}),
            ...(customer.taxId ? {rut: customer.taxId.trim()} : {}),
            // Klap exige nombre y apellido juntos.
            ...(first && rest.length > 0 ? {first_name: first, last_name: rest.join(' ')} : {}),
            ...(customer.phone ? {phone: customer.phone.trim()} : {}),
        };
        return Object.keys(user).length > 0 ? user : undefined;
    }

    private customs(input: NormalizedCreateInput<KlapCheckoutExtras>, methods: string[]): Array<{
        key: string;
        value: string
    }> {
        const customs: Array<{ key: string; value: string }> = [];
        // La expiración es obligatoria para cada medio; con `*` van los tres.
        const minutes = input.expiresAt
            ? Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000))
            : KLAP_API.defaultExpirationMinutes;
        const names = methods.includes('*') ? [...KLAP_API.methods] : methods;
        for (const name of names) customs.push({key: `${name}_expiration_minutes`, value: String(minutes)});
        if (input.extras?.quotasAllowed) customs.push({
            key: 'tarjetas_quotas_allowed',
            value: input.extras.quotasAllowed
        });
        for (const [key, value] of Object.entries({...input.metadata, ...input.extras?.customs})) {
            customs.push({key, value});
        }
        return customs;
    }
}

export function createKlapCheckout(config: KlapConfig): KlapCheckout {
    return new KlapCheckout(config);
}
