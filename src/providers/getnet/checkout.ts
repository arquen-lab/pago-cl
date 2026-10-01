import {invalidInput, missingField, returnMismatch} from '../../core/errors';
import {readCurrency} from '../../core/money';
import {bodyParams} from '../../core/request';
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
    type RefundResult,
} from '../../core/types';
import {
    GETNET_API,
    GETNET_FORBIDDEN_CHARS,
    type GetnetCreateRequest,
    type GetnetCreateResponse,
    type GetnetNotification,
    type GetnetReverseResponse,
    type GetnetSessionResponse,
    type GetnetTransaction,
    mapGetnetStatus,
} from './api';
import {type GetnetConfig, GetnetCore} from './core';

/** Campos de Web Checkout que no están en el checkout común. */
export interface GetnetCheckoutExtras {
    /** `skipResult`: vuelve al comercio sin mostrar el comprobante de Getnet. */
    skipResult?: boolean;
    /** `buyer.documentType`, por ejemplo `CLRUT`. Se envía junto a `customer.taxId`. */
    documentType?: string;
    /** `fields`: pares que Getnet guarda con la transacción. */
    fields?: Record<string, string>;
}

export const GETNET_EXTRAS: readonly ExtrasField<ExtrasKey<GetnetCheckoutExtras>>[] = [
    {
        key: 'skipResult',
        type: 'boolean',
        label: 'skipResult',
        description: 'Vuelve al comercio sin mostrar el comprobante de Getnet.'
    },
    {
        key: 'documentType',
        type: 'string',
        label: 'documentType',
        description: 'Tipo del documento en customer.taxId, por ejemplo CLRUT.'
    },
    {
        key: 'fields',
        type: 'json',
        label: 'fields',
        description: 'Pares clave-valor que Getnet guarda con la transacción.'
    },
];

export const GETNET_CAPABILITIES: Capabilities = {
    currencies: ['CLP'],
    capture: false,
    refund: {partial: false, async: false},
    cancel: {unpaid: false, authorized: false},
    notifications: {mode: 'optional', delivery: 'account-manual', verification: 'signature'},
    lookupByOrderId: false,
    requires: {create: ['client.ip', 'client.userAgent']},
};

export class GetnetCheckout implements CheckoutProduct<GetnetCheckoutExtras> {
    readonly id = 'getnet';
    readonly capabilities = GETNET_CAPABILITIES;
    readonly extrasSchema = GETNET_EXTRAS;
    private readonly core: GetnetCore;

    constructor(config: GetnetConfig) {
        this.core = new GetnetCore(config);
    }

    async create(input: NormalizedCreateInput<GetnetCheckoutExtras>): Promise<CreateResult> {
        const ip = input.client?.ip?.trim();
        const userAgent = input.client?.userAgent?.trim();
        if (!ip) throw missingField('client.ip', this.core.label);
        if (!userAgent) throw missingField('client.userAgent', this.core.label);
        if (input.orderId.length > GETNET_API.limits.reference) {
            throw invalidInput('orderId', `Getnet admite referencias de hasta ${GETNET_API.limits.reference} caracteres.`);
        }
        const description = input.description.slice(0, GETNET_API.limits.description);
        if (GETNET_FORBIDDEN_CHARS.test(description)) {
            throw invalidInput('description', 'Getnet no admite [] {} | " \' \\ * = ~ ¡ ! en los textos.');
        }
        const expiresAt = input.expiresAt ?? new Date(Date.now() + GETNET_API.defaultExpirationMinutes * 60_000);
        if (expiresAt.getTime() - Date.now() < GETNET_API.minExpirationMinutes * 60_000) {
            throw invalidInput('expiresAt', `Getnet exige al menos ${GETNET_API.minExpirationMinutes} minutos de vigencia.`);
        }
        const extras = input.extras;
        const buyer = this.buyer(input);
        const body: Omit<GetnetCreateRequest, 'auth'> = {
            locale: this.core.locale,
            ...(buyer ? {buyer} : {}),
            payment: {
                reference: input.orderId,
                description,
                amount: {currency: input.currency, total: input.amount},
            },
            expiration: expiresAt.toISOString(),
            returnUrl: input.returnUrl,
            ...(input.cancelUrl ? {cancelUrl: input.cancelUrl} : {}),
            ipAddress: ip.slice(0, GETNET_API.limits.ipAddress),
            userAgent: userAgent.slice(0, GETNET_API.limits.userAgent),
            ...(extras?.skipResult !== undefined ? {skipResult: extras.skipResult} : {}),
            ...(extras?.fields || input.metadata
                ? {
                    fields: Object.entries({...input.metadata, ...extras?.fields}).map(([keyword, value]) => ({
                        keyword,
                        value,
                        displayOn: 'none',
                    })),
                }
                : {}),
        };
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.post<GetnetCreateResponse>(GETNET_API.paths.createSession, body);
        if (!data.requestId || !data.processUrl) {
            throw invalidInput('response', 'Getnet no devolvió requestId ni processUrl.');
        }
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: String(data.requestId),
                data: {amount: input.amount, currency: input.currency},
            },
            redirectUrl: data.processUrl,
            rawRequest,
            rawResponse,
        };
    }

    /** El retorno no trae parámetros: se consulta la sesión con el requestId guardado. */
    async handleReturn(ref: PaymentRef, _request: IncomingRequest): Promise<PaymentResult> {
        return this.getStatus(ref);
    }

    /**
     * Notificación firmada con sha256(requestId + status + date + secretKey).
     * Se verifica y luego se reconsulta la sesión, como recomienda el manual.
     */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        const notification = bodyParams(request) as unknown as GetnetNotification;
        if (!notification.requestId || !notification.status) {
            return {reply: {status: 400, body: 'notificación incompleta'}};
        }
        this.core.verifyNotification(notification);
        const ref: PaymentRef = {
            provider: this.id,
            orderId: notification.reference ?? '',
            transactionId: String(notification.requestId),
        };
        const result = await this.getStatus(ref);
        return {
            result,
            eventId: `${notification.requestId}:${notification.status.status}:${notification.status.date ?? ''}`,
            reply: {status: 200},
        };
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {
            data,
            rawRequest,
            rawResponse
        } = await this.core.post<GetnetSessionResponse>(GETNET_API.paths.session(ref.transactionId), {});
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    /** Solo total, con el `internalReference` del pago aprobado. */
    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        if (input.amount !== undefined) {
            throw invalidInput('amount', 'Getnet solo reversa el monto total por API.');
        }
        const current = await this.getStatus(ref);
        const internalReference = current.ref.data?.internalReference;
        if (current.status !== 'PAID' || internalReference === undefined) {
            throw invalidInput('ref', `La sesión está ${current.status}; solo se reversa un pago aprobado.`);
        }
        const {data, rawRequest, rawResponse} = await this.core.post<GetnetReverseResponse>(GETNET_API.paths.reverse, {
            internalReference: String(internalReference),
        });
        const ok = data.status.status === 'APPROVED';
        return {
            refund: {
                provider: this.id,
                refundId: input.refundId,
                providerRefundId: data.payment?.receipt,
                payment: ref
            },
            status: ok ? 'SUCCEEDED' : 'FAILED',
            amount: Math.abs(data.payment?.amount?.to?.total ?? current.amount),
            providerStatus: data.status.status,
            rawRequest,
            rawResponse,
        };
    }

    private map(ref: PaymentRef, data: GetnetSessionResponse): PaymentResult {
        const reference = data.request?.payment?.reference;
        if (ref.orderId && reference && reference !== ref.orderId) {
            throw returnMismatch(this.core.label, `reference ${reference}`);
        }
        const approved = (data.payment ?? []).find((item) => item.status?.status === 'APPROVED');
        const last: GetnetTransaction | undefined = approved ?? (data.payment ?? [])[(data.payment ?? []).length - 1];
        const status = mapGetnetStatus(data.status);
        const requested = data.request?.payment?.amount;
        const amount = last?.amount?.from?.total ?? requested?.total ?? Number(ref.data?.amount ?? 0);
        const currency = readCurrency(last?.amount?.from?.currency ?? requested?.currency ?? (ref.data?.currency as string | undefined));
        const cardType = last?.processorFields?.find((field) => field.keyword === 'cardType')?.value;
        return {
            ref: {
                ...ref,
                orderId: ref.orderId || reference || '',
                data: {
                    ...ref.data,
                    amount,
                    currency,
                    ...(approved ? {internalReference: approved.internalReference} : {}),
                },
            },
            status,
            final: isFinalStatus(status),
            amount,
            currency,
            refundedAmount: approved?.refunded || data.status.status === 'REFUNDED' ? amount : 0,
            authorizationCode: approved?.authorization,
            paymentMethod: [last?.paymentMethodName ?? last?.paymentMethod, typeof cardType === 'string' ? cardType : undefined].filter(Boolean).join(' ') || undefined,
            providerStatus: data.status.reason ? `${data.status.status}:${data.status.reason}` : data.status.status,
            ...(data.status.message ? {statusDetail: data.status.message} : {}),
        };
    }

    private buyer(input: NormalizedCreateInput<GetnetCheckoutExtras>): GetnetCreateRequest['buyer'] | undefined {
        const customer = input.customer;
        if (!customer) return undefined;
        const [name, ...rest] = (customer.name ?? '').trim().split(/\s+/).filter(Boolean);
        const buyer: GetnetCreateRequest['buyer'] = {
            ...(customer.email ? {email: customer.email.trim()} : {}),
            ...(name ? {name} : {}),
            ...(rest.length > 0 ? {surname: rest.join(' ')} : {}),
            ...(customer.phone ? {mobile: customer.phone.trim()} : {}),
            ...(customer.taxId ? {
                document: customer.taxId.trim(),
                documentType: input.extras?.documentType ?? 'CLRUT'
            } : {}),
        };
        return Object.keys(buyer).length > 0 ? buyer : undefined;
    }
}

export function createGetnetCheckout(config: GetnetConfig): GetnetCheckout {
    return new GetnetCheckout(config);
}
