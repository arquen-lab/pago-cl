import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
    PaymentAdapter,
    createPaymentAdapter,
    fromWebRequest,
    requestFields,
    type Capabilities,
    type CheckoutProduct,
    type CreateResult,
    type PaymentAdapterConfig,
    type PaymentResult,
} from '../../src';

const capabilities: Capabilities = {
    currencies: ['CLP', 'UF'],
    capture: false,
    refund: { partial: false, async: false },
    cancel: { unpaid: false, authorized: false },
    notifications: { mode: 'none', delivery: 'none', verification: 'none' },
    lookupByOrderId: false,
    requires: { create: ['customer.email'] },
};

function fakeProduct(): CheckoutProduct<void> & { create: ReturnType<typeof vi.fn> } {
    const paid = (orderId: string): PaymentResult => ({
        ref: { provider: 'fake', orderId, transactionId: 'tx' },
        status: 'PAID',
        final: true,
        amount: 1000,
        currency: 'CLP',
        refundedAmount: 0,
        providerStatus: 'ok',
        rawRequest: { method: 'GET', url: 'https://fake' },
        rawResponse: { ok: true },
    });
    return {
        id: 'fake',
        capabilities,
        extrasSchema: [],
        create: vi.fn(async (input): Promise<CreateResult> => ({
            ref: { provider: 'fake', orderId: input.orderId, transactionId: 'tx' },
            redirectUrl: 'https://fake/pay',
            rawRequest: { method: 'POST', url: 'https://fake', body: input },
            rawResponse: { id: 'tx' },
        })),
        handleReturn: vi.fn(async (ref) => paid(ref.orderId)),
        getStatus: vi.fn(async (ref) => paid(ref.orderId)),
        refund: vi.fn(async (ref, input) => ({
            refund: { provider: 'fake', refundId: input.refundId, payment: ref },
            status: 'SUCCEEDED' as const,
            amount: input.amount ?? 1000,
        })),
    };
}

const valid = { orderId: 'ORD-1', amount: 1000, returnUrl: 'https://shop.example/pago/ORD-1', customer: { email: 'a@b.cl' } };

describe('PaymentAdapter', () => {
    it('aplica defaults: descripción, moneda y orderId generado', async () => {
        const product = fakeProduct();
        const adapter = new PaymentAdapter(product);
        const created = await adapter.create({ amount: 1000, returnUrl: valid.returnUrl, customer: valid.customer });
        expect(product.create).toHaveBeenCalledWith(
            expect.objectContaining({ currency: 'CLP', description: `Orden ${created.ref.orderId}` }),
        );
        expect(created.ref.orderId).toHaveLength(26);
    });

    it('valida la precisión por moneda', async () => {
        const adapter = new PaymentAdapter(fakeProduct());
        await expect(adapter.create({ ...valid, amount: 10.5 })).rejects.toMatchObject({ field: 'amount' });
        await expect(adapter.create({ ...valid, currency: 'UF', amount: 2.12345 })).rejects.toMatchObject({ field: 'amount' });
        await expect(adapter.create({ ...valid, currency: 'UF', amount: 2.1234 })).resolves.toBeDefined();
    });

    it('exige los campos que declara el producto', async () => {
        const adapter = new PaymentAdapter(fakeProduct());
        await expect(adapter.create({ ...valid, customer: {} })).rejects.toMatchObject({ code: 'MISSING_FIELD', field: 'customer.email' });
    });

    it('rechaza expiresAt inválido y URLs relativas', async () => {
        const adapter = new PaymentAdapter(fakeProduct());
        await expect(adapter.create({ ...valid, expiresAt: new Date('x') })).rejects.toMatchObject({ field: 'expiresAt' });
        await expect(adapter.create({ ...valid, notificationUrl: '/hook' })).rejects.toMatchObject({ field: 'notificationUrl' });
    });

    it('handleReturn rechaza un resultado de otra orden', async () => {
        const product = fakeProduct();
        product.handleReturn = vi.fn(async (): Promise<PaymentResult> => ({
            ref: { provider: 'fake', orderId: 'OTRA', transactionId: 'tx' },
            status: 'PAID',
            final: true,
            amount: 1,
            currency: 'CLP',
            refundedAmount: 0,
            providerStatus: 'ok',
        }));
        await expect(
            new PaymentAdapter(product).handleReturn({ provider: 'fake', orderId: 'ORD-1', transactionId: 'tx' }, { method: 'GET', url: '/', headers: {} }),
        ).rejects.toMatchObject({ code: 'RETURN_MISMATCH' });
    });

    it('refund genera refundId y bloquea el parcial cuando la capacidad lo niega', async () => {
        const product = fakeProduct();
        const adapter = new PaymentAdapter(product);
        const ref = { provider: 'fake', orderId: 'ORD-1', transactionId: 'tx' };
        const refund = await adapter.refund(ref);
        expect(refund.refund.refundId).toMatch(/^ref_/);
        await expect(adapter.refund(ref, { amount: 10 })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });

    it('raw: por defecto quita rawRequest; con rawRequest lo deja y con rawResponse false lo quita', async () => {
        const product = fakeProduct();
        const byDefault = await new PaymentAdapter(product).create(valid);
        expect(byDefault.rawRequest).toBeUndefined();
        expect(byDefault.rawResponse).toEqual({ id: 'tx' });
        const both = await new PaymentAdapter(product, { rawRequest: true, rawResponse: false }).create(valid);
        expect(both.rawRequest).toBeDefined();
        expect(both.rawResponse).toBeUndefined();
    });
});

describe('createPaymentAdapter', () => {
    it('tipa env y extras según provider', () => {
        expectTypeOf<PaymentAdapterConfig<'flow'>['env']>().toHaveProperty('secretKey');
        expectTypeOf<PaymentAdapterConfig<'venti'>['env']>().not.toHaveProperty('secretKey');
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'c', apiKey: 'k', deferredCommerceCode: 'd' } });
        expect(adapter.provider).toBe('transbank');
        expect(adapter.capabilities.capture).toBeTruthy();
        // @ts-expect-error extras de otra pasarela
        void adapter.create({ amount: 1, returnUrl: 'https://t.cl', extras: { statementDescriptor: 'x' } });
    });
});

describe('request helpers', () => {
    it('mezcla query y cuerpo form; el cuerpo gana', () => {
        const fields = requestFields({
            method: 'POST',
            url: 'https://t.cl/pago?token=q&provider=flow',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'token=b',
        });
        expect(fields).toEqual({ token: 'b', provider: 'flow' });
    });

    it('convierte un Request estándar', async () => {
        const request = await fromWebRequest(
            new Request('https://t.cl/webhooks/venti', { method: 'POST', headers: { 'venti-signature': 't=1,v1=x' }, body: '{"id":"evt_1"}' }),
        );
        expect(request).toMatchObject({ method: 'POST', url: 'https://t.cl/webhooks/venti', body: '{"id":"evt_1"}' });
        expect(request.headers['venti-signature']).toBe('t=1,v1=x');
    });
});
