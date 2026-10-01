import {missingField, returnMismatch} from '../../core/errors';
import {readCurrency} from '../../core/money';
import {queryParams, requestFields} from '../../core/request';
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
    FLOW_API,
    type FlowCreatePaymentResponse,
    type FlowParams,
    flowRedirectUrl,
    type FlowRefundResponse,
    type FlowStatusResponse,
    mapFlowRefundStatus,
    mapFlowStatus,
} from './api';
import {type FlowConfig, FlowCore} from './core';

/** Campos de Flow que no están en el checkout común. Email y nombre van en `customer`. */
export interface FlowCheckoutExtras {
    /** `paymentMethod`. `9` es todos los medios contratados. */
    paymentMethod?: number;
    /** `merchantId`. Comercio asociado (integradores). */
    merchantId?: string;
    /** `payment_currency`. Moneda en que se espera el pago. */
    paymentCurrency?: string;
    /** `checkout_timeout`. Segundos para elegir medio de pago. */
    checkoutTimeout?: number;
    /** Claves extra para el JSON `optional`. */
    optional?: Record<string, string>;
}

export const FLOW_CAPABILITIES: Capabilities = {
    currencies: ['CLP', 'UF'],
    capture: false,
    refund: {partial: true, async: true},
    cancel: {unpaid: false, authorized: false},
    notifications: {mode: 'required', delivery: 'per-request', verification: 'requery'},
    lookupByOrderId: true,
    requires: {create: ['customer.email'], refund: []},
};

export const FLOW_EXTRAS: readonly ExtrasField<ExtrasKey<FlowCheckoutExtras>>[] = [
    {
        key: 'paymentMethod',
        type: 'number',
        label: 'paymentMethod',
        description: '9 = todos los medios contratados. Si se envía, va directo a ese medio.'
    },
    {
        key: 'checkoutTimeout',
        type: 'number',
        label: 'checkout_timeout',
        description: 'Segundos para elegir medio de pago.'
    },
    {key: 'merchantId', type: 'string', label: 'merchantId', description: 'Comercio asociado (integradores).'},
    {
        key: 'paymentCurrency',
        type: 'string',
        label: 'payment_currency',
        description: 'Moneda en que se espera el pago.'
    },
    {key: 'optional', type: 'json', label: 'optional', description: 'Claves extra del JSON optional.'},
];

export class FlowCheckout implements CheckoutProduct<FlowCheckoutExtras> {
    readonly id = 'flow';
    readonly capabilities = FLOW_CAPABILITIES;
    readonly extrasSchema = FLOW_EXTRAS;
    private readonly core: FlowCore;

    constructor(config: FlowConfig) {
        this.core = new FlowCore(config);
    }

    async create(input: NormalizedCreateInput<FlowCheckoutExtras>): Promise<CreateResult> {
        const email = input.customer?.email?.trim();
        if (!email) throw missingField('customer.email', this.core.label);
        const urlConfirmation = this.core.notificationUrl('payment', input.notificationUrl);
        if (!urlConfirmation) throw missingField('notificationUrl', this.core.label);

        const extras = input.extras;
        const optional = this.optionalJson(input);
        const timeout = input.expiresAt ? Math.max(60, Math.round((input.expiresAt.getTime() - Date.now()) / 1000)) : undefined;
        const params: FlowParams = {
            commerceOrder: input.orderId,
            subject: input.description,
            amount: input.amount,
            email,
            urlConfirmation,
            urlReturn: input.returnUrl,
            ...(input.currency !== 'CLP' ? {currency: input.currency} : {}),
            ...(optional ? {optional} : {}),
            ...(extras?.paymentMethod !== undefined ? {paymentMethod: extras.paymentMethod} : {}),
            ...(timeout !== undefined ? {timeout} : {}),
            ...(extras?.checkoutTimeout !== undefined ? {checkout_timeout: extras.checkoutTimeout} : {}),
            ...(extras?.merchantId ? {merchantId: extras.merchantId} : {}),
            ...(extras?.paymentCurrency ? {payment_currency: extras.paymentCurrency} : {}),
        };
        const {data, rawRequest, rawResponse} = await this.core.post<FlowCreatePaymentResponse>(
            FLOW_API.paths.createPayment,
            params,
        );
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.token,
                data: {
                    flowOrder: data.flowOrder,
                    amount: input.amount,
                    currency: input.currency,
                    email,
                    ...(input.notificationUrl ? {notificationUrl: input.notificationUrl} : {}),
                },
            },
            redirectUrl: flowRedirectUrl(data),
            rawRequest,
            rawResponse,
        };
    }

    /** Flow vuelve por POST con `token`. El resultado siempre sale de la consulta. */
    async handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult> {
        const token = requestFields(request).token?.trim();
        if (token && token !== ref.transactionId) {
            throw returnMismatch(this.core.label, 'el token no es el de esta orden');
        }
        return this.getStatus(ref);
    }

    /** Solo llega `token`. `?kind=` (puesto por el SDK) dice si es pago o reembolso. */
    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        const token = requestFields(request).token?.trim();
        if (!token) {
            return {reply: {status: 400, body: 'token requerido'}};
        }
        const kind = queryParams(request).kind;
        if (kind === 'refund') {
            const refund = await this.refundByToken(token);
            return {refund, eventId: `refund:${token}`, reply: {status: 200}};
        }
        const {data, rawRequest, rawResponse} = await this.core.get<FlowStatusResponse>(FLOW_API.paths.getStatus, {
            token,
        });
        const ref: PaymentRef = {
            provider: this.id,
            orderId: data.commerceOrder,
            transactionId: token,
            data: {flowOrder: data.flowOrder},
        };
        return {
            result: {...this.map(ref, data), rawRequest, rawResponse},
            eventId: `payment:${token}:${data.status}`,
            reply: {status: 200},
        };
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.core.get<FlowStatusResponse>(FLOW_API.paths.getStatus, {
            token: ref.transactionId,
        });
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const receiverEmail = input.receiverEmail?.trim() || (ref.data?.email as string | undefined);
        if (!receiverEmail) throw missingField('receiverEmail', this.core.label);
        const urlCallBack = this.core.notificationUrl('refund', ref.data?.notificationUrl as string | undefined);
        if (!urlCallBack) throw missingField('notificationUrl', this.core.label);
        const amount = input.amount ?? (await this.getStatus(ref)).amount;
        const flowOrder = ref.data?.flowOrder;
        const params: FlowParams = {
            refundCommerceOrder: input.refundId,
            receiverEmail,
            amount,
            urlCallBack,
            ...(flowOrder !== undefined ? {flowTrxId: String(flowOrder)} : {commerceTrxId: ref.orderId}),
        };
        const {data, rawRequest, rawResponse} = await this.core.post<FlowRefundResponse>(
            FLOW_API.paths.createRefund,
            params,
        );
        return {
            refund: {provider: this.id, refundId: input.refundId, providerRefundId: data.token, payment: ref},
            status: mapFlowRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    async getRefund(refund: RefundRef): Promise<RefundResult> {
        if (!refund.providerRefundId) throw missingField('providerRefundId', this.core.label);
        return this.refundByToken(refund.providerRefundId, refund);
    }

    private async refundByToken(token: string, known?: RefundRef): Promise<RefundResult> {
        const {data, rawRequest, rawResponse} = await this.core.get<FlowRefundResponse>(FLOW_API.paths.refundStatus, {
            token,
        });
        return {
            refund: known ?? {
                provider: this.id,
                refundId: String(data.flowRefundOrder),
                providerRefundId: token,
                payment: {provider: this.id, orderId: '', transactionId: ''},
            },
            status: mapFlowRefundStatus(data.status),
            amount: data.amount,
            providerStatus: data.status,
            rawRequest,
            rawResponse,
        };
    }

    private map(ref: PaymentRef, data: FlowStatusResponse): PaymentResult {
        if (data.commerceOrder && data.commerceOrder !== ref.orderId) {
            throw returnMismatch(this.core.label, `commerceOrder ${data.commerceOrder}`);
        }
        const status = mapFlowStatus(Number(data.status));
        return {
            ref: {...ref, data: {...ref.data, flowOrder: data.flowOrder}},
            status,
            final: isFinalStatus(status),
            amount: data.amount,
            currency: readCurrency(data.currency),
            refundedAmount: 0,
            paymentMethod: data.paymentData?.media,
            providerStatus: String(data.status),
        };
    }

    private optionalJson(input: NormalizedCreateInput<FlowCheckoutExtras>): string | undefined {
        const optional: Record<string, string> = {...(input.metadata ?? {}), ...(input.extras?.optional ?? {})};
        const name = input.customer?.name?.trim();
        const phone = input.customer?.phone?.trim();
        const rut = input.customer?.taxId?.trim();
        if (name) optional.nombre = name;
        if (phone) optional.telefono = phone;
        if (rut) optional.rut = rut;
        return Object.keys(optional).length > 0 ? JSON.stringify(optional) : undefined;
    }
}

export function createFlowCheckout(config: FlowConfig): FlowCheckout {
    return new FlowCheckout(config);
}
