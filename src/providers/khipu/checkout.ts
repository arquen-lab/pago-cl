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
    KHIPU_API,
    type KhipuCreateRequest,
    type KhipuCreateResponse,
    type KhipuNotification,
    type KhipuPayment,
    type KhipuRefundResponse,
    mapKhipuRefundStatus,
    mapKhipuStatus,
} from './api';
import {type KhipuConfig, KhipuCore} from './core';

/** Campos de Khipu que no están en el checkout común. */
export interface KhipuCheckoutExtras {
    /** `bank_id`: banco preseleccionado (ver `GET /v3/banks`). */
    bankId?: string;
    /** `mandatory_payment_method`: solo se podrá pagar con ese medio. */
    mandatoryPaymentMethod?: string;
    /** `fixed_payer_personal_identifier`: solo podrá pagar quien tenga ese RUT. */
    fixedPayerPersonalIdentifier?: string;
    /** `send_email`: Khipu envía el cobro por correo. Exige `customer.name` y `customer.email`. */
    sendEmail?: boolean;
    /** `send_reminders`: recordatorios de cobro. */
    sendReminders?: boolean;
    /** `picture_url`: foto del producto o servicio. */
    pictureUrl?: string;
    /** `custom`: texto libre que Khipu guarda con el cobro. Por defecto `metadata` como JSON. */
    custom?: string;
}

export const KHIPU_EXTRAS: readonly ExtrasField<ExtrasKey<KhipuCheckoutExtras>>[] = [
    {
        key: 'bankId',
        type: 'string',
        label: 'bank_id',
        description: 'Banco preseleccionado (GET /v3/banks).',
        maxLength: 5
    },
    {
        key: 'mandatoryPaymentMethod',
        type: 'string',
        label: 'mandatory_payment_method',
        description: 'Solo se podrá pagar con este medio.'
    },
    {
        key: 'fixedPayerPersonalIdentifier',
        type: 'string',
        label: 'fixed_payer_personal_identifier',
        description: 'Solo podrá pagar quien tenga este RUT.'
    },
    {
        key: 'sendEmail',
        type: 'boolean',
        label: 'send_email',
        description: 'Khipu envía el cobro por correo (exige customer.name y customer.email).'
    },
    {key: 'sendReminders', type: 'boolean', label: 'send_reminders', description: 'Recordatorios de cobro.'},
    {key: 'pictureUrl', type: 'string', label: 'picture_url', description: 'Foto del producto o servicio.'},
    {
        key: 'custom',
        type: 'string',
        label: 'custom',
        description: 'Texto libre guardado con el cobro. Por defecto, metadata como JSON.'
    },
];

export const KHIPU_CAPABILITIES: Capabilities = {
    currencies: ['CLP', 'UF', 'USD'],
    capture: false,
    // Devolución total o parcial: requiere habilitación y billetera con saldo; se paga después.
    refund: {partial: true, async: true, windowDays: 180},
    cancel: {unpaid: true, authorized: false},
    notifications: {mode: 'optional', delivery: 'per-request', verification: 'signature'},
    lookupByOrderId: false,
    requires: {create: []},
};

export class KhipuCheckout implements CheckoutProduct<KhipuCheckoutExtras> {
    readonly id = 'khipu';
    readonly capabilities = KHIPU_CAPABILITIES;
    readonly extrasSchema = KHIPU_EXTRAS;
    private readonly core: KhipuCore;

    constructor(config: KhipuConfig) {
        this.core = new KhipuCore(config);
    }

    async create(input: NormalizedCreateInput<KhipuCheckoutExtras>): Promise<CreateResult> {
        const extras = input.extras;
        if (extras?.sendEmail && (!input.customer?.email || !input.customer.name)) {
            throw invalidInput('customer', 'send_email exige customer.name y customer.email.');
        }
        for (const [field, url] of [
            ['returnUrl', input.returnUrl],
            ['cancelUrl', input.cancelUrl],
            ['notificationUrl', input.notificationUrl],
        ] as const) {
            if (url && url.length > KHIPU_API.limits.url) {
                throw invalidInput(field, `Khipu admite URLs de hasta ${KHIPU_API.limits.url} caracteres.`);
            }
        }
        const custom = extras?.custom ?? (input.metadata ? JSON.stringify(input.metadata) : undefined);
        const body: KhipuCreateRequest = {
            amount: input.amount,
            currency: input.currency === 'UF' ? 'CLF' : input.currency,
            subject: input.description.slice(0, KHIPU_API.limits.subject),
            transaction_id: input.orderId,
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl ?? input.returnUrl,
            ...(input.notificationUrl ? {
                notify_url: input.notificationUrl,
                notify_api_version: KHIPU_API.notifyApiVersion
            } : {}),
            ...(input.expiresAt ? {expires_date: input.expiresAt.toISOString()} : {}),
            ...(input.customer?.name ? {payer_name: input.customer.name.trim()} : {}),
            ...(input.customer?.email ? {payer_email: input.customer.email.trim()} : {}),
            ...(custom ? {custom} : {}),
            ...(extras?.sendEmail !== undefined ? {send_email: extras.sendEmail} : {}),
            ...(extras?.sendReminders !== undefined ? {send_reminders: extras.sendReminders} : {}),
            ...(extras?.pictureUrl ? {picture_url: extras.pictureUrl} : {}),
            ...(extras?.bankId ? {bank_id: extras.bankId} : {}),
            ...(extras?.mandatoryPaymentMethod ? {mandatory_payment_method: extras.mandatoryPaymentMethod} : {}),
            ...(extras?.fixedPayerPersonalIdentifier ? {fixed_payer_personal_identifier: extras.fixedPayerPersonalIdentifier} : {}),
        };
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<KhipuCreateResponse>('POST', KHIPU_API.paths.payments, body);
        if (!data.payment_id || !data.payment_url) {
            throw invalidInput('response', 'Khipu no devolvió payment_id ni payment_url.');
        }
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.payment_id,
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.payment_url,
            rawRequest,
            rawResponse,
        };
    }

    /**
     * `return_url` no trae datos y Khipu pide mostrar "en verificación" hasta la conciliación:
     * el resultado sale de la consulta y puede ser PENDING. El final llega por webhook.
     */
    async handleReturn(ref: PaymentRef, _request: IncomingRequest): Promise<PaymentResult> {
        return this.getStatus(ref);
    }

    /**
     * Hoy Khipu solo emite el evento de conciliación exitosa, firmado con el secreto de la cuenta.
     * Se verifica la firma y el evento es el resultado: un pago PAID.
     */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        this.core.verifyNotification(request);
        let event: KhipuNotification;
        try {
            event = JSON.parse(request.body ?? '') as KhipuNotification;
        } catch {
            return {reply: {status: 400, body: 'cuerpo no es JSON'}};
        }
        if (!event.payment_id) return {reply: {status: 400, body: 'falta payment_id'}};
        const currency = readCurrency(event.currency);
        const amount = Number(event.amount ?? 0);
        const ref: PaymentRef = {
            provider: this.id,
            orderId: event.transaction_id ?? '',
            transactionId: event.payment_id,
            data: {amount, currency},
        };
        return {
            result: {
                ref,
                status: 'PAID',
                final: true,
                amount,
                currency,
                refundedAmount: 0,
                authorizationCode: event.authorizer_operation_code,
                paymentMethod: [event.payment_method, event.bank].filter(Boolean).join(' ') || undefined,
                providerStatus: event.out_of_date_conciliation ? 'done:out-of-date' : 'done',
                rawResponse: event,
            },
            eventId: `${event.payment_id}:${event.conciliation_date ?? ''}`,
            reply: {status: 200},
        };
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.fetchPayment(ref.transactionId);
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    /** `DELETE /v3/payments/{id}`: solo un cobro pendiente, y no se puede deshacer. */
    async cancel(ref: PaymentRef): Promise<PaymentResult> {
        const current = await this.getStatus(ref);
        if (current.status !== 'PENDING') {
            throw invalidInput('ref', `Solo se cancela un cobro pendiente; este está ${current.status}.`);
        }
        const {data, rawRequest, rawResponse} = await this.core.request<{ message?: string }>(
            'DELETE',
            KHIPU_API.paths.payment(ref.transactionId),
        );
        return {
            ...current,
            status: 'CANCELED',
            final: true,
            providerStatus: 'deleted',
            ...(data?.message ? {statusDetail: data.message} : {}),
            rawRequest,
            rawResponse,
        };
    }

    /**
     * `POST /v3/refunds`. Sin monto: `type: full`. Khipu deja la devolución marcada y la paga
     * después (necesita habilitación y saldo en la billetera de devoluciones), así que nace PENDING.
     * Khipu no ofrece clave de idempotencia: repetir la llamada pide otra devolución.
     */
    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const body =
            input.amount !== undefined
                ? {type: 'partial', payment_id: ref.transactionId, amount: String(input.amount)}
                : {type: 'full', payment_id: ref.transactionId};
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.request<KhipuRefundResponse>('POST', KHIPU_API.paths.refunds, body);
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: data.id, payment: ref},
            status: 'PENDING',
            amount: Number(data.refunded_amount),
            refundableAmount: Number(data.remaining),
            providerStatus: 'requested',
            ...(data.message ? {statusDetail: data.message} : {}),
            rawRequest,
            rawResponse,
        } as RefundResult;
    }

    /** El estado de cada devolución viene en `refunds` del pago. */
    async getRefund(refund: RefundRef): Promise<RefundResult> {
        if (!refund.providerRefundId) throw invalidInput('refund', 'Falta providerRefundId.');
        const {data, rawRequest, rawResponse} = await this.fetchPayment(refund.payment.transactionId);
        const item = data.refunds?.find((candidate) => candidate.id === refund.providerRefundId);
        if (!item) throw invalidInput('refund', `Khipu no tiene la devolución ${refund.providerRefundId} en ese pago.`);
        return {
            refund,
            status: mapKhipuRefundStatus(item.status),
            amount: Number(item.amount),
            providerStatus: item.status,
            rawRequest,
            rawResponse,
        };
    }

    private fetchPayment(paymentId: string) {
        return this.core.request<KhipuPayment>('GET', KHIPU_API.paths.payment(paymentId));
    }

    private map(ref: PaymentRef, data: KhipuPayment): PaymentResult {
        if (ref.orderId && data.transaction_id && data.transaction_id !== ref.orderId) {
            throw returnMismatch(this.core.label, `transaction_id ${data.transaction_id}`);
        }
        const amount = data.amount !== undefined ? Number(data.amount) : Number(ref.data?.amount ?? 0);
        const currency = readCurrency(data.currency, readCurrency(ref.data?.currency as string | undefined));
        const {status, refundedAmount} = mapKhipuStatus({...data, amount});
        return {
            ref: {...ref, data: {...ref.data, amount, currency}},
            status,
            final: isFinalStatus(status),
            amount,
            currency,
            refundedAmount,
            authorizationCode: data.authorizer_operation_code,
            paymentMethod: [data.payment_method, data.funds_source, data.bank].filter((part) => part && part !== 'not-available' && part !== 'not_available').join(' ') || undefined,
            providerStatus: data.status_detail ? `${data.status}:${data.status_detail}` : (data.status ?? ''),
        };
    }
}

export function createKhipuCheckout(config: KhipuConfig): KhipuCheckout {
    return new KhipuCheckout(config);
}
