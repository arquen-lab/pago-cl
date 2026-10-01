import {PaymentAdapter, type RawCaptureOptions} from './core/engine';
import type {CheckoutProduct} from './core/types';
import {createFintocCheckout, type FintocCheckoutExtras} from './providers/fintoc/checkout';
import type {FintocConfig} from './providers/fintoc/core';
import {createFlowCheckout, type FlowCheckoutExtras} from './providers/flow/checkout';
import type {FlowConfig} from './providers/flow/core';
import {createGetnetCheckout, type GetnetCheckoutExtras} from './providers/getnet/checkout';
import type {GetnetConfig} from './providers/getnet/core';
import {createKhipuCheckout, type KhipuCheckoutExtras} from './providers/khipu/checkout';
import type {KhipuConfig} from './providers/khipu/core';
import {createKlapCheckout, type KlapCheckoutExtras} from './providers/klap/checkout';
import type {KlapConfig} from './providers/klap/core';
import {createMercadoPagoCheckout, type MercadoPagoCheckoutExtras} from './providers/mercadopago/checkout';
import type {MercadoPagoConfig} from './providers/mercadopago/core';
import type {TransbankConfig} from './providers/transbank/core';
import {createWebpayPlus, type TransbankCheckoutExtras} from './providers/transbank/webpay-plus';
import {createVentiCheckout, type VentiCheckoutExtras} from './providers/venti/checkout';
import type {VentiConfig} from './providers/venti/core';

export type ProviderEnv = {
    transbank: TransbankConfig;
    flow: FlowConfig;
    mercadopago: MercadoPagoConfig;
    venti: VentiConfig;
    getnet: GetnetConfig;
    klap: KlapConfig;
    khipu: KhipuConfig;
    fintoc: FintocConfig;
};

export type ProviderCheckoutExtras = {
    transbank: TransbankCheckoutExtras;
    flow: FlowCheckoutExtras;
    mercadopago: MercadoPagoCheckoutExtras;
    venti: VentiCheckoutExtras;
    getnet: GetnetCheckoutExtras;
    klap: KlapCheckoutExtras;
    khipu: KhipuCheckoutExtras;
    fintoc: FintocCheckoutExtras;
};

export type ProviderId = keyof ProviderEnv;

export const PROVIDER_IDS = ['transbank', 'flow', 'mercadopago', 'venti', 'getnet', 'klap', 'khipu', 'fintoc'] as const satisfies readonly ProviderId[];

export type PaymentAdapterConfig<T extends ProviderId = ProviderId> = {
    [K in T]: {
        provider: K;
        env: ProviderEnv[K];
        /** Incluir el request enviado a la pasarela. Default: false. */
        rawRequest?: boolean;
        /** Incluir la respuesta de la pasarela. Default: true. */
        rawResponse?: boolean;
    };
}[T];

const factories: { [K in ProviderId]: (env: ProviderEnv[K]) => CheckoutProduct<ProviderCheckoutExtras[K]> } = {
    transbank: (env) => createWebpayPlus(env),
    flow: (env) => createFlowCheckout(env),
    mercadopago: (env) => createMercadoPagoCheckout(env),
    venti: (env) => createVentiCheckout(env),
    getnet: (env) => createGetnetCheckout(env),
    klap: (env) => createKlapCheckout(env),
    khipu: (env) => createKhipuCheckout(env),
    fintoc: (env) => createFintocCheckout(env),
};

/**
 * Una pasarela por cliente. `env` y `extras` se tipan desde `provider`.
 *
 * @example
 * ```ts
 * const payments = createPaymentAdapter({
 *   provider: 'venti',
 *   env: { apiKey, webhookSecret },
 * });
 * const { ref, redirectUrl } = await payments.create({ orderId, amount: 12990, returnUrl });
 * ```
 */
export function createPaymentAdapter<T extends ProviderId>(
    config: PaymentAdapterConfig<T>,
): PaymentAdapter<ProviderCheckoutExtras[T]> {
    const factory = factories[config.provider] as (env: ProviderEnv[T]) => CheckoutProduct<ProviderCheckoutExtras[T]>;
    const options: RawCaptureOptions = {rawRequest: config.rawRequest, rawResponse: config.rawResponse};
    return new PaymentAdapter(factory(config.env), options);
}

export function isProviderId(value: string): value is ProviderId {
    return (PROVIDER_IDS as readonly string[]).includes(value);
}
