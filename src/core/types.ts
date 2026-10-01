export type Currency = 'CLP' | 'UF' | 'USD';

export type Environment = 'sandbox' | 'production';

/**
 * Estado común de un pago.
 * PENDING y AUTHORIZED no son finales; el resto sí.
 * El reembolso no es un estado: va en `refundedAmount`.
 */
export type PaymentStatus = 'PENDING' | 'AUTHORIZED' | 'PAID' | 'REJECTED' | 'CANCELED' | 'EXPIRED';

export type RefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export interface Customer {
    email?: string;
    name?: string;
    phone?: string;
    /** RUT u otro documento del pagador. */
    taxId?: string;
}

export interface ClientInfo {
    ip?: string;
    userAgent?: string;
}

/** Campos que solo existen en una pasarela. `void` significa que no tiene. */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` hace opcional el parámetro extras cuando la pasarela no tiene.
export type ProviderExtras = object | void;

export interface CreateInput<TExtras extends ProviderExtras = void> {
    /** Hasta 26 caracteres: letras, números, `-` y `_`. Se genera si falta. */
    orderId?: string;
    /** CLP entero; UF hasta 4 decimales; USD hasta 2. */
    amount: number;
    /** Por defecto CLP. */
    currency?: Currency;
    description?: string;
    /** URL tuya. Conviene poner el orderId en la ruta: https://shop.example/pago/ORD-1. */
    returnUrl: string;
    cancelUrl?: string;
    /** Adónde manda la pasarela sus notificaciones. Las que no notifican la ignoran. */
    notificationUrl?: string;
    customer?: Customer;
    client?: ClientInfo;
    expiresAt?: Date;
    /** `manual` deja el pago autorizado hasta `capture()`. Solo si la pasarela lo soporta. */
    capture?: 'automatic' | 'manual';
    metadata?: Record<string, string>;
    extras?: TExtras;
}

/** Lo que guardas junto a tu orden. Sirve para todas las operaciones posteriores. */
export interface PaymentRef {
    provider: string;
    orderId: string;
    /** Id del checkout en la pasarela. No cambia durante la vida del pago. */
    transactionId: string;
    /** Datos que el adapter necesita después (ids secundarios, montos). Opaco. */
    data?: Record<string, unknown>;
}

/** Llamada saliente a la pasarela, sin credenciales. */
export interface ProviderRawRequest {
    method: string;
    url: string;
    body?: unknown;
}

export interface WithRaw {
    rawRequest?: ProviderRawRequest;
    rawResponse?: unknown;
}

export interface CreateResult extends WithRaw {
    ref: PaymentRef;
    redirectUrl: string;
}

export interface PaymentResult extends WithRaw {
    ref: PaymentRef;
    status: PaymentStatus;
    /** true cuando el estado ya no va a cambiar por sí solo. */
    final: boolean;
    amount: number;
    currency: Currency;
    refundedAmount: number;
    authorizationCode?: string;
    paymentMethod?: string;
    /** Estado crudo de la pasarela. */
    providerStatus: string;
    /** Mensaje legible de la pasarela sobre el estado, cuando lo trae (por ejemplo por qué se reversó). */
    statusDetail?: string;
}

export interface RefundInput {
    /** Clave de idempotencia. Se genera si falta. */
    refundId?: string;
    /** Sin monto: reembolso total. */
    amount?: number;
    reason?: string;
    /** Flow lo exige. */
    receiverEmail?: string;
}

export interface RefundRef {
    provider: string;
    refundId: string;
    providerRefundId?: string;
    payment: PaymentRef;
}

export interface RefundResult extends WithRaw {
    refund: RefundRef;
    status: RefundStatus;
    amount: number;
    /** Lo que aún se puede reembolsar, cuando la pasarela lo informa. */
    refundableAmount?: number;
    providerStatus?: string;
}

export interface HttpReply {
    status: number;
    body?: string;
    headers?: Record<string, string>;
}

/** Request HTTP entrante, neutro respecto del framework. `body` es el cuerpo crudo. */
export interface IncomingRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

export interface NotificationResult {
    /** Presente cuando la notificación habla de un pago. */
    result?: PaymentResult;
    /** Presente cuando habla de un reembolso. */
    refund?: RefundResult;
    /** Para deduplicar. */
    eventId?: string;
    /** Lo que hay que responderle a la pasarela. */
    reply: HttpReply;
}

/**
 * Qué tan necesario es el webhook para esta pasarela.
 * - `none`: no existe; el resultado sale del retorno y de `getStatus`.
 * - `optional`: el pago se confirma sin él (retorno + `getStatus`); sirve para enterarse aunque el comprador cierre el navegador.
 * - `required`: sin él la pasarela rechaza el cobro o lo revierte; `create` falla con `MISSING_FIELD` si falta la URL.
 */
export type NotificationMode = 'none' | 'optional' | 'required';
export type NotificationDelivery = 'per-request' | 'account-api' | 'account-manual' | 'none';
export type NotificationVerification = 'signature' | 'requery' | 'none';

export interface Capabilities {
    currencies: readonly Currency[];
    capture: false | { partial: boolean; windowMinutes?: number };
    refund: false | { partial: boolean | 'conditional'; async: boolean; windowDays?: number };
    cancel: { unpaid: boolean; authorized: boolean };
    notifications: { mode: NotificationMode; delivery: NotificationDelivery; verification: NotificationVerification };
    lookupByOrderId: boolean;
    /** Campos de CreateInput y RefundInput que esta pasarela exige. */
    requires: { create?: readonly string[]; refund?: readonly string[] };
}

/**
 * Descripción de un campo de `extras`, para que una UI lo dibuje sin conocer la pasarela.
 * `key` admite rutas con punto (`paymentMethods.installments`).
 */
export type ExtrasField<TKey extends string = string> = {
    key: TKey;
    label: string;
    description?: string;
} & (
    | { type: 'string'; maxLength?: number }
    | { type: 'number'; min?: number; max?: number }
    | { type: 'boolean' }
    | { type: 'select'; options: readonly string[] }
    | { type: 'multiselect'; options: readonly string[] }
    | { type: 'string[]' }
    | { type: 'json' }
    );

/** Claves válidas de `extras` hasta un nivel de anidación. */
export type ExtrasKey<TExtras> = TExtras extends object
    ? {
        [K in keyof TExtras & string]: NonNullable<TExtras[K]> extends readonly unknown[]
            ? K
            : NonNullable<TExtras[K]> extends Record<string, unknown>
                ? K | `${K}.${keyof NonNullable<TExtras[K]> & string}`
                : K;
    }[keyof TExtras & string]
    : never;

/** CreateInput ya validado y con defaults. Es lo que recibe cada producto. */
export interface NormalizedCreateInput<TExtras extends ProviderExtras = void>
    extends Omit<CreateInput<TExtras>, 'orderId' | 'currency' | 'description'> {
    orderId: string;
    currency: Currency;
    description: string;
}

/** Un producto de una pasarela (por ejemplo Webpay Plus). Lo envuelve PaymentAdapter. */
export interface CheckoutProduct<TExtras extends ProviderExtras = void> {
    readonly id: string;
    readonly capabilities: Capabilities;
    /** Campos de `extras` que acepta este producto. Vacío si no tiene. */
    readonly extrasSchema: readonly ExtrasField<ExtrasKey<TExtras>>[];

    create(input: NormalizedCreateInput<TExtras>): Promise<CreateResult>;

    handleReturn(ref: PaymentRef, request: IncomingRequest): Promise<PaymentResult>;

    handleNotification?(request: IncomingRequest): Promise<NotificationResult>;

    getStatus(ref: PaymentRef): Promise<PaymentResult>;

    capture?(ref: PaymentRef, amount?: number): Promise<PaymentResult>;

    cancel?(ref: PaymentRef): Promise<PaymentResult>;

    refund?(ref: PaymentRef, input: RefundInput & { refundId: string }): Promise<RefundResult>;

    getRefund?(refund: RefundRef): Promise<RefundResult>;
}

export function isFinalStatus(status: PaymentStatus): boolean {
    return status !== 'PENDING' && status !== 'AUTHORIZED';
}
