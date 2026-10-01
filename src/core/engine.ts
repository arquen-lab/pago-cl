import {invalidInput, missingField, notSupported, returnMismatch} from './errors';
import {assertAmount, resolveCurrency} from './money';
import {assertOrderId, generateOrderId, generateRefundId} from './order-id';
import type {
    Capabilities,
    CheckoutProduct,
    CreateInput,
    CreateResult,
    ExtrasField,
    IncomingRequest,
    NormalizedCreateInput,
    NotificationResult,
    PaymentRef,
    PaymentResult,
    ProviderExtras,
    RefundInput,
    RefundRef,
    RefundResult,
    WithRaw,
} from './types';

export interface RawCaptureOptions {
    /** Incluir el request enviado a la pasarela. Default: false. */
    rawRequest?: boolean;
    /** Incluir la respuesta de la pasarela. Default: true. */
    rawResponse?: boolean;
}

/**
 * Cliente de pagos atado a un producto de una pasarela.
 * Valida lo común, aplica defaults y delega en el producto.
 */
export class PaymentAdapter<TExtras extends ProviderExtras = void> {
    private readonly raw: { rawRequest: boolean; rawResponse: boolean };

    constructor(
        private readonly product: CheckoutProduct<TExtras>,
        options: RawCaptureOptions = {},
    ) {
        this.raw = {
            rawRequest: options.rawRequest ?? false,
            rawResponse: options.rawResponse ?? true,
        };
    }

    get provider(): string {
        return this.product.id;
    }

    get capabilities(): Capabilities {
        return this.product.capabilities;
    }

    /** Campos de `extras` de esta pasarela, para dibujar un formulario. */
    get extrasSchema(): readonly ExtrasField[] {
        return this.product.extrasSchema;
    }

    async create(input: CreateInput<TExtras>): Promise<CreateResult> {
        const normalized = this.normalize(input);
        return this.present(await this.product.create(normalized));
    }

    async handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult> {
        this.assertRef(ref);
        const result = await this.product.handleReturn(ref, request);
        if (result.ref.orderId !== ref.orderId) {
            throw returnMismatch(this.provider, `orden ${result.ref.orderId} en vez de ${ref.orderId}`);
        }
        return this.present(result);
    }

    async handleNotification(request: IncomingRequest): Promise<NotificationResult> {
        if (!this.product.handleNotification) {
            throw notSupported(this.provider, 'notificaciones');
        }
        const notification = await this.product.handleNotification(request);
        return {
            ...notification,
            ...(notification.result ? {result: this.present(notification.result)} : {}),
            ...(notification.refund ? {refund: this.present(notification.refund)} : {}),
        };
    }

    async getStatus(ref: PaymentRef): Promise<PaymentResult> {
        this.assertRef(ref);
        return this.present(await this.product.getStatus(ref));
    }

    async capture(ref: PaymentRef, amount?: number): Promise<PaymentResult> {
        this.assertRef(ref);
        if (!this.product.capture || !this.capabilities.capture) {
            throw notSupported(this.provider, 'captura diferida');
        }
        if (amount !== undefined) {
            assertAmount(amount, this.refCurrency(ref));
        }
        return this.present(await this.product.capture(ref, amount));
    }

    async cancel(ref: PaymentRef): Promise<PaymentResult> {
        this.assertRef(ref);
        if (!this.product.cancel) {
            throw notSupported(this.provider, 'cancelación');
        }
        return this.present(await this.product.cancel(ref));
    }

    async refund(ref: PaymentRef, input: RefundInput = {}): Promise<RefundResult> {
        this.assertRef(ref);
        const capability = this.capabilities.refund;
        if (!this.product.refund || !capability) {
            throw notSupported(this.provider, 'reembolso');
        }
        if (input.amount !== undefined) {
            assertAmount(input.amount, this.refCurrency(ref));
            if (capability.partial === false) {
                throw notSupported(this.provider, 'reembolso parcial');
            }
        }
        for (const field of this.capabilities.requires.refund ?? []) {
            if (!readPath(input as Record<string, unknown>, field)) {
                throw missingField(field, this.provider);
            }
        }
        const refundId = input.refundId?.trim() || generateRefundId();
        return this.present(await this.product.refund(ref, {...input, refundId}));
    }

    async getRefund(refund: RefundRef): Promise<RefundResult> {
        if (!this.product.getRefund) {
            throw notSupported(this.provider, 'consulta de reembolso');
        }
        return this.present(await this.product.getRefund(refund));
    }

    private normalize(input: CreateInput<TExtras>): NormalizedCreateInput<TExtras> {
        const currency = resolveCurrency(this.capabilities.currencies, input.currency, this.provider);
        assertAmount(input.amount, currency);
        const orderId = input.orderId?.trim() ? assertOrderId(input.orderId.trim()) : generateOrderId();
        if (!isAbsoluteUrl(input.returnUrl)) {
            throw invalidInput('returnUrl', 'returnUrl tiene que ser una URL absoluta.');
        }
        if (input.cancelUrl !== undefined && !isAbsoluteUrl(input.cancelUrl)) {
            throw invalidInput('cancelUrl', 'cancelUrl tiene que ser una URL absoluta.');
        }
        if (input.notificationUrl !== undefined && !isAbsoluteUrl(input.notificationUrl)) {
            throw invalidInput('notificationUrl', 'notificationUrl tiene que ser una URL absoluta.');
        }
        if (input.expiresAt !== undefined && !(input.expiresAt instanceof Date && !Number.isNaN(input.expiresAt.getTime()))) {
            throw invalidInput('expiresAt', 'expiresAt tiene que ser una fecha válida.');
        }
        if (input.capture === 'manual' && !this.capabilities.capture) {
            throw notSupported(this.provider, 'captura diferida');
        }
        for (const field of this.capabilities.requires.create ?? []) {
            if (!readPath(input as unknown as Record<string, unknown>, field)) {
                throw missingField(field, this.provider);
            }
        }
        return {
            ...input,
            orderId,
            currency,
            description: input.description?.trim() || `Orden ${orderId}`,
        };
    }

    private assertRef(ref: PaymentRef): void {
        if (ref.provider !== this.provider) {
            throw invalidInput('ref', `La referencia es de ${ref.provider}, no de ${this.provider}.`);
        }
        if (!ref.orderId || !ref.transactionId) {
            throw invalidInput('ref', 'La referencia necesita orderId y transactionId.');
        }
    }

    private refCurrency(ref: PaymentRef) {
        const stored = ref.data?.currency;
        return stored === 'UF' || stored === 'USD' ? stored : 'CLP';
    }

    private present<T extends WithRaw>(result: T): T {
        if (this.raw.rawRequest && this.raw.rawResponse) return result;
        const next = {...result};
        if (!this.raw.rawRequest) delete next.rawRequest;
        if (!this.raw.rawResponse) delete next.rawResponse;
        return next;
    }
}

function isAbsoluteUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function readPath(source: Record<string, unknown>, path: string): unknown {
    let current: unknown = source;
    for (const key of path.split('.')) {
        if (!current || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return typeof current === 'string' ? current.trim() : current;
}
