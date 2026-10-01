import {invalidInput, isPaymentError, returnMismatch} from '../../core/errors';
import {requestFields} from '../../core/request';
import {
    type Capabilities,
    type CheckoutProduct,
    type CreateResult,
    type ExtrasField,
    type ExtrasKey,
    type IncomingRequest,
    isFinalStatus,
    type NormalizedCreateInput,
    type PaymentRef,
    type PaymentResult,
    type RefundInput,
    type RefundResult,
} from '../../core/types';
import {
    mapTransbankStatus,
    TRANSBANK_API,
    type TransbankCaptureRequest,
    type TransbankCaptureResponse,
    type TransbankCreateRequest,
    type TransbankCreateResponse,
    transbankRedirectUrl,
    type TransbankRefundResponse,
    type TransbankTransactionResponse,
} from './api';
import {type TransbankConfig, TransbankCore} from './core';

/** Campos de Webpay que no están en el checkout común. */
export interface TransbankCheckoutExtras {
    /** `session_id`. Se genera desde el orderId cuando falta. */
    sessionId?: string;
}

export const WEBPAY_PLUS_EXTRAS: readonly ExtrasField<ExtrasKey<TransbankCheckoutExtras>>[] = [
    {
        key: 'sessionId',
        type: 'string',
        label: 'session_id',
        description: 'Hasta 61 caracteres. Se genera desde el orderId si falta.',
        maxLength: 61
    },
];

export function webpayPlusCapabilities(deferredAvailable: boolean): Capabilities {
    return {
        currencies: ['CLP'],
        capture: deferredAvailable ? {partial: true, windowMinutes: 7 * 24 * 60} : false,
        refund: {partial: 'conditional', async: false, windowDays: 90},
        cancel: {unpaid: false, authorized: false},
        notifications: {mode: 'none', delivery: 'none', verification: 'none'},
        lookupByOrderId: false,
        requires: {},
    };
}

/**
 * Webpay Plus. Con `deferredCommerceCode` en el env, `create({ capture: 'manual' })`
 * usa Captura Diferida: el commit autoriza y `capture()` cobra. La ref recuerda
 * con qué código se creó el pago, porque todas las llamadas posteriores lo necesitan.
 */
export class WebpayPlusCheckout implements CheckoutProduct<TransbankCheckoutExtras> {
    readonly id = 'transbank';
    readonly capabilities: Capabilities;
    readonly extrasSchema = WEBPAY_PLUS_EXTRAS;
    private readonly core: TransbankCore;

    constructor(config: TransbankConfig) {
        this.core = new TransbankCore(config);
        this.capabilities = webpayPlusCapabilities(Boolean(this.core.deferredCommerceCode));
    }

    async create(input: NormalizedCreateInput<TransbankCheckoutExtras>): Promise<CreateResult> {
        if (input.returnUrl.length > TRANSBANK_API.limits.returnUrl) {
            throw invalidInput('returnUrl', `Transbank admite returnUrl de hasta ${TRANSBANK_API.limits.returnUrl} caracteres.`);
        }
        const deferred = input.capture === 'manual';
        const sessionId = (input.extras?.sessionId?.trim() || `sess_${input.orderId}`).slice(
            0,
            TRANSBANK_API.limits.sessionId,
        );
        const body: TransbankCreateRequest = {
            buy_order: input.orderId,
            session_id: sessionId,
            amount: input.amount,
            return_url: input.returnUrl,
        };
        const {data, rawRequest, rawResponse} = await this.core.request<TransbankCreateResponse>(
            'POST',
            TRANSBANK_API.paths.transactions,
            body,
            deferred,
        );
        return {
            ref: {
                provider: this.id,
                orderId: input.orderId,
                transactionId: data.token,
                data: {amount: input.amount, currency: 'CLP', deferred},
            },
            redirectUrl: transbankRedirectUrl(data),
            rawRequest,
            rawResponse,
        };
    }

    /**
     * Cuatro retornos documentados:
     * - `token_ws` solo: pago terminado, hay que hacer commit.
     * - `TBK_TOKEN` (con o sin `token_ws`): el usuario anuló o hubo error.
     * - solo `TBK_ORDEN_COMPRA` + `TBK_ID_SESION`: expiró el formulario.
     */
    async handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult> {
        const fields = requestFields(request);
        const tokenWs = fields.token_ws?.trim();
        const abortToken = fields.TBK_TOKEN?.trim();
        const buyOrder = fields.TBK_ORDEN_COMPRA?.trim();

        if (buyOrder && buyOrder !== ref.orderId) {
            throw returnMismatch(this.core.label, `TBK_ORDEN_COMPRA ${buyOrder}`);
        }
        for (const token of [tokenWs, abortToken]) {
            if (token && token !== ref.transactionId) {
                throw returnMismatch(this.core.label, 'el token no es el de esta orden');
            }
        }

        if (abortToken) {
            const status = await this.status(ref);
            return status.status === 'PENDING'
                ? {...status, status: 'CANCELED', final: true, providerStatus: 'ABORTED'}
                : status;
        }
        if (!tokenWs) {
            const status = await this.status(ref);
            return status.status === 'PENDING'
                ? {...status, status: 'EXPIRED', final: true, providerStatus: 'TIMEOUT'}
                : status;
        }
        return this.commit(ref);
    }

    getStatus(ref: PaymentRef): Promise<PaymentResult> {
        return this.status(ref);
    }

    async capture(ref: PaymentRef, amount?: number): Promise<PaymentResult> {
        if (!isDeferred(ref)) {
            throw invalidInput('ref', 'Este pago se creó con captura automática; no hay nada que capturar.');
        }
        const current = await this.status(ref);
        const authorizationCode = current.authorizationCode;
        if (current.status !== 'AUTHORIZED' || !authorizationCode) {
            throw invalidInput('ref', `La transacción está ${current.status}; solo se captura una AUTHORIZED.`);
        }
        const captureAmount = amount ?? current.amount;
        if (captureAmount > current.amount) {
            throw invalidInput('amount', 'El monto a capturar no puede superar el autorizado.');
        }
        const body: TransbankCaptureRequest = {
            buy_order: ref.orderId,
            authorization_code: authorizationCode,
            capture_amount: captureAmount,
        };
        const {data, rawRequest, rawResponse} = await this.core.request<TransbankCaptureResponse>(
            'PUT',
            TRANSBANK_API.paths.capture(ref.transactionId),
            body,
            true,
        );
        const captured = data.response_code === 0;
        return {
            ref,
            status: captured ? 'PAID' : 'AUTHORIZED',
            final: captured,
            amount: captured ? (data.captured_amount ?? captureAmount) : current.amount,
            currency: 'CLP',
            refundedAmount: 0,
            authorizationCode: data.authorization_code || authorizationCode,
            paymentMethod: current.paymentMethod,
            providerStatus: captured ? 'CAPTURED' : `CAPTURE_REJECTED_${data.response_code}`,
            rawRequest,
            rawResponse,
        };
    }

    async refund(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult> {
        const amount = input.amount ?? (await this.status(ref)).amount;
        const {data, rawRequest, rawResponse} = await this.core.request<TransbankRefundResponse>(
            'POST',
            TRANSBANK_API.paths.refunds(ref.transactionId),
            {amount},
            isDeferred(ref),
        );
        const ok = data.type === 'REVERSED' || data.response_code === 0;
        return {
            refund: {
                provider: this.id,
                refundId: input.refundId,
                providerRefundId: data.authorization_code,
                payment: ref,
            },
            status: ok ? 'SUCCEEDED' : 'FAILED',
            amount: data.nullified_amount ?? amount,
            refundableAmount: data.balance,
            providerStatus: data.type,
            rawRequest,
            rawResponse,
        };
    }

    private async commit(ref: PaymentRef): Promise<PaymentResult> {
        try {
            const {data, rawRequest, rawResponse} = await this.core.request<TransbankTransactionResponse>(
                'PUT',
                TRANSBANK_API.paths.transaction(ref.transactionId),
                undefined,
                isDeferred(ref),
            );
            return {...this.map(ref, data), rawRequest, rawResponse};
        } catch (error) {
            // Un segundo commit (refresco del retorno) falla con 422; el estado ya está en la consulta.
            if (isPaymentError(error) && error.provider?.httpStatus === 422) {
                return this.status(ref);
            }
            throw error;
        }
    }

    private async status(ref: PaymentRef): Promise<PaymentResult> {
        const {data, rawRequest, rawResponse} = await this.core.request<TransbankTransactionResponse>(
            'GET',
            TRANSBANK_API.paths.transaction(ref.transactionId),
            undefined,
            isDeferred(ref),
        );
        return {...this.map(ref, data), rawRequest, rawResponse};
    }

    private map(ref: PaymentRef, data: TransbankTransactionResponse): PaymentResult {
        if (data.buy_order && data.buy_order !== ref.orderId) {
            throw returnMismatch(this.core.label, `buy_order ${data.buy_order}`);
        }
        const {status, refundedAmount} = mapTransbankStatus(data, isDeferred(ref));
        return {
            ref: {
                ...ref,
                data: {
                    ...ref.data,
                    ...(data.authorization_code ? {authorizationCode: data.authorization_code} : {}),
                },
            },
            status,
            final: isFinalStatus(status),
            amount: data.amount,
            currency: 'CLP',
            refundedAmount,
            authorizationCode: data.authorization_code,
            paymentMethod: data.payment_type_code,
            providerStatus: data.status,
        };
    }
}

function isDeferred(ref: PaymentRef): boolean {
    return ref.data?.deferred === true;
}

export function createWebpayPlus(config: TransbankConfig): WebpayPlusCheckout {
    return new WebpayPlusCheckout(config);
}
