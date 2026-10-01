import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { hmacSha256Hex } from '../../src/core/webhooks';
import { VENTI_API } from '../../src/providers/venti/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch } from '../helpers/fetch';

const env = { apiKey: 'key_test_venti', webhookSecret: 'whs_test' };
const ref: PaymentRef = { provider: 'venti', orderId: 'ORD-VENTI-1', transactionId: 'chk_123', data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-VENTI-1';

function checkout(status: string, extra: Record<string, unknown> = {}) {
    return {
        id: 'chk_123',
        url: 'https://pay.ventipay.com/checkout/chk_123',
        status,
        external_id: 'ORD-VENTI-1',
        amount: 15000,
        currency: 'clp',
        payment_id: status === 'paid' ? 'pay_1' : null,
        successful_object: status === 'paid' ? 'payment' : null,
        successful_object_id: status === 'paid' ? 'pay_1' : null,
        refunded: false,
        refunded_amount: 0,
        payment: status === 'paid' ? { id: 'pay_1', status: 'succeeded', authorized: true, captured: true } : null,
        payment_method: status === 'paid' ? { type: 'kushki_cards', brand: 'visa', last4: '4242' } : null,
        ...extra,
    };
}
const paid = checkout('paid');

describeCheckoutContract('venti', {
    adapter: () => createPaymentAdapter({ provider: 'venti', env }),
    createInput: { orderId: 'ORD-VENTI-1', amount: 15000, returnUrl },
    createResponse: { body: checkout('unpaid') },
    createdTransactionId: 'chk_123',
    ref,
    paidResponse: { body: paid },
    statuses: [
        { name: 'unpaid', responses: [{ body: checkout('unpaid') }], expect: { status: 'PENDING' } },
        { name: 'paid', responses: [{ body: paid }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'paid con pago sin capturar', responses: [{ body: checkout('paid', { payment: { id: 'pay_1', status: 'requires_capture' } }) }], expect: { status: 'AUTHORIZED' } },
        { name: 'paid reembolsado parcialmente', responses: [{ body: checkout('paid', { refunded: true, refunded_amount: 5000 }) }], expect: { status: 'PAID', refundedAmount: 5000 } },
        { name: 'paid reembolsado sin monto informado', responses: [{ body: checkout('paid', { refunded: true, refunded_amount: undefined }) }], expect: { status: 'PAID', refundedAmount: 15000 } },
        { name: 'canceled', responses: [{ body: checkout('canceled') }], expect: { status: 'CANCELED' } },
        { name: 'expired', responses: [{ body: checkout('expired') }], expect: { status: 'EXPIRED' } },
    ],
    returns: [
        { name: 'el retorno no trae datos: consulta el checkout', request: getRequest(returnUrl), responses: [{ body: paid }], expect: 'PAID' },
        { name: 'cancelado por el cliente sigue unpaid', request: getRequest(returnUrl), responses: [{ body: checkout('unpaid') }], expect: 'PENDING' },
        { name: 'external_id de otra orden', request: getRequest(`${returnUrl}?external_id=OTRA`), expect: 'RETURN_MISMATCH' },
    ],
});

describe('Venti Checkout', () => {
    it('crea el checkout en minúsculas con un ítem, URLs por GET y eventos de notificación', async () => {
        const calls = mockFetch([{ body: checkout('unpaid') }]);
        await createPaymentAdapter({ provider: 'venti', env }).create({
            orderId: 'ORD-VENTI-1',
            amount: 15000,
            description: 'Cobro',
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            notificationUrl: 'https://shop.example/webhooks/venti',
            metadata: { carro: 'c1' },
        });
        expect(calls[0].url).toBe(`${VENTI_API.baseUrl}/checkouts`);
        expect(calls[0].headers.Authorization).toBe('Bearer key_test_venti');
        expect(calls[0].json()).toEqual({
            currency: 'clp',
            items: [{ name: 'Cobro', unit_price: 15000, quantity: 1 }],
            external_id: 'ORD-VENTI-1',
            description: 'Cobro',
            success_url: returnUrl,
            cancel_url: 'https://shop.example/cancel',
            success_url_method: 'get',
            cancel_url_method: 'get',
            metadata: { carro: 'c1' },
            notification_url: 'https://shop.example/webhooks/venti',
            notification_events: ['checkout.created', 'checkout.paid', 'checkout.refunded', 'checkout.canceled'],
        });
    });

    it('UF se envía como clf en unidades de 1/10000 y vuelve en UF', async () => {
        const calls = mockFetch([{ body: checkout('unpaid', { currency: 'clf', amount: 25000 }) }, { body: checkout('paid', { currency: 'clf', amount: 25000 }) }]);
        const adapter = createPaymentAdapter({ provider: 'venti', env });
        const created = await adapter.create({ orderId: 'ORD-VENTI-1', amount: 2.5, currency: 'UF', returnUrl });
        expect(calls[0].json()).toMatchObject({ currency: 'clf', items: [{ unit_price: 25000 }] });
        const result = await adapter.getStatus(created.ref);
        expect(result).toMatchObject({ amount: 2.5, currency: 'UF' });
    });

    it('capture manual envía authorize:false', async () => {
        const calls = mockFetch([{ body: checkout('unpaid') }]);
        await createPaymentAdapter({ provider: 'venti', env }).create({ orderId: 'ORD-VENTI-1', amount: 15000, returnUrl, capture: 'manual' });
        expect(calls[0].json()).toMatchObject({ authorize: false });
    });

    it('captura el pago autorizado y devuelve el estado nuevo', async () => {
        const calls = mockFetch([
            { body: checkout('paid', { payment: { id: 'pay_1', status: 'requires_capture' } }) },
            { body: { id: 'pay_1', status: 'succeeded' } },
            { body: paid },
        ]);
        const result = await createPaymentAdapter({ provider: 'venti', env }).capture(ref);
        expect(calls[1].url).toBe(`${VENTI_API.baseUrl}/payments/pay_1/capture`);
        expect(result.status).toBe('PAID');
    });

    it('no admite captura parcial', async () => {
        mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'venti', env }).capture(ref, 1000)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('cancela un checkout sin pagar', async () => {
        const calls = mockFetch([{ body: checkout('unpaid') }, { body: checkout('canceled') }, { body: checkout('canceled') }]);
        const result = await createPaymentAdapter({ provider: 'venti', env }).cancel(ref);
        expect(calls[1].url).toBe(`${VENTI_API.baseUrl}/checkouts/chk_123/cancel`);
        expect(result.status).toBe('CANCELED');
    });

    it('libera una autorización sin capturar', async () => {
        const calls = mockFetch([
            { body: checkout('paid', { payment: { id: 'pay_1', status: 'requires_capture' } }) },
            { body: {} },
            { body: checkout('canceled') },
        ]);
        await createPaymentAdapter({ provider: 'venti', env }).cancel(ref);
        expect(calls[1].url).toBe(`${VENTI_API.baseUrl}/payments/pay_1/cancel`);
    });

    it('reembolsa con X-Idempotency y nace PENDING', async () => {
        const calls = mockFetch([{ body: { id: 'ref_1', status: 'pending', amount: 5000, checkout_id: 'chk_123' } }]);
        const refund = await createPaymentAdapter({ provider: 'venti', env }).refund(ref, { refundId: 'rf-v-1', amount: 5000 });
        expect(calls[0].url).toBe(`${VENTI_API.baseUrl}/checkouts/chk_123/refund`);
        expect(calls[0].headers['X-Idempotency']).toBe('rf-v-1');
        expect(calls[0].json()).toEqual({ destination: 'payment_method', amount: 5000 });
        expect(refund).toMatchObject({ status: 'PENDING', amount: 5000, refund: { providerRefundId: 'ref_1' } });
    });

    it('getRefund consulta el reembolso', async () => {
        const calls = mockFetch([{ body: { id: 'ref_1', status: 'succeeded', amount: 5000 } }]);
        const refund = await createPaymentAdapter({ provider: 'venti', env }).getRefund({ provider: 'venti', refundId: 'rf', providerRefundId: 'ref_1', payment: ref });
        expect(calls[0].url).toBe(`${VENTI_API.baseUrl}/refunds/ref_1`);
        expect(refund.status).toBe('SUCCEEDED');
    });

    function signedEvent(event: unknown, secret = env.webhookSecret, t = Math.floor(Date.now() / 1000)) {
        const body = JSON.stringify(event);
        const v1 = hmacSha256Hex(secret, `${t}.${body}`);
        return { method: 'POST', url: 'https://shop.example/webhooks/venti', headers: { 'content-type': 'application/json', 'venti-signature': `t=${t},v1=${v1}` }, body };
    }

    it('verifica la firma y lee el checkout del evento sin consultar', async () => {
        const calls = mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'venti', env }).handleNotification(
            signedEvent({ id: 'evt_1', type: 'checkout.paid', live: false, data: paid }),
        );
        expect(calls).toHaveLength(0);
        expect(notification).toMatchObject({ eventId: 'evt_1', reply: { status: 200 }, result: { status: 'PAID', ref: { orderId: 'ORD-VENTI-1', transactionId: 'chk_123' } } });
    });

    it('rechaza una firma con otro secreto', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'venti', env }).handleNotification(signedEvent({ id: 'evt_1', type: 'checkout.paid', data: paid }, 'otro')),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('rechaza una firma vencida', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'venti', env }).handleNotification(
                signedEvent({ id: 'evt_1', type: 'checkout.paid', data: paid }, env.webhookSecret, Math.floor(Date.now() / 1000) - 3600),
            ),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('un evento de reembolso trae RefundResult', async () => {
        const notification = await createPaymentAdapter({ provider: 'venti', env }).handleNotification(
            signedEvent({ id: 'evt_2', type: 'refund.succeeded', data: { id: 'ref_1', status: 'succeeded', amount: 5000, checkout_id: 'chk_123' } }),
        );
        expect(notification.refund).toMatchObject({ status: 'SUCCEEDED', amount: 5000 });
        expect(notification.result).toBeUndefined();
    });

    it('un cuerpo de error con messages[] llega al mensaje', async () => {
        mockFetch([{ status: 400, body: { type: 'invalid_request_error', code: 'parameter_invalid', messages: ['currency is invalid'] } }]);
        await expect(createPaymentAdapter({ provider: 'venti', env }).getStatus(ref)).rejects.toMatchObject({
            code: 'PROVIDER_ERROR',
            message: 'Venti: currency is invalid',
            provider: { providerCode: 'parameter_invalid', httpStatus: 400 },
        });
    });
});
