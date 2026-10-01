import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { hmacSha256Hex } from '../../src/core/webhooks';
import { MERCADOPAGO_API } from '../../src/providers/mercadopago/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch, postJson } from '../helpers/fetch';

const env = { accessToken: 'APP_USR-test', webhookSecret: 'mp-secret' };
const preferenceId = '123456789-abcd-1234-abcd-123456789abc';
const ref: PaymentRef = { provider: 'mercadopago', orderId: 'ORD-MP-1', transactionId: preferenceId, data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-MP-1';

function payment(status: string, extra: Record<string, unknown> = {}) {
    return {
        id: 987654321,
        external_reference: 'ORD-MP-1',
        status,
        status_detail: status === 'approved' ? 'accredited' : undefined,
        transaction_amount: 15000,
        transaction_amount_refunded: 0,
        currency_id: 'CLP',
        authorization_code: '301299',
        payment_method_id: 'master',
        ...extra,
    };
}
const approved = payment('approved');
const search = (results: unknown[]) => ({ body: { results, paging: { total: results.length } } });

describeCheckoutContract('mercadopago', {
    adapter: () => createPaymentAdapter({ provider: 'mercadopago', env }),
    createInput: { orderId: 'ORD-MP-1', amount: 15000, returnUrl },
    createResponse: { body: { id: preferenceId, init_point: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=x', sandbox_init_point: 'https://sandbox.mercadopago.cl/x' } },
    createdTransactionId: preferenceId,
    ref,
    paidResponse: search([approved]),
    statuses: [
        { name: 'sin pagos para la orden', responses: [search([])], expect: { status: 'PENDING', amount: 15000 } },
        { name: 'pending', responses: [search([payment('pending')])], expect: { status: 'PENDING' } },
        { name: 'in_process', responses: [search([payment('in_process')])], expect: { status: 'PENDING' } },
        { name: 'in_mediation', responses: [search([payment('in_mediation')])], expect: { status: 'PENDING' } },
        { name: 'authorized', responses: [search([payment('authorized')])], expect: { status: 'AUTHORIZED' } },
        { name: 'approved', responses: [search([approved])], expect: { status: 'PAID', amount: 15000 } },
        { name: 'approved con reembolso parcial', responses: [search([payment('approved', { status_detail: 'partially_refunded', transaction_amount_refunded: 5000 })])], expect: { status: 'PAID', refundedAmount: 5000 } },
        { name: 'rejected', responses: [search([payment('rejected', { status_detail: 'cc_rejected_insufficient_amount' })])], expect: { status: 'REJECTED' } },
        { name: 'cancelled', responses: [search([payment('cancelled', { status_detail: 'by_collector' })])], expect: { status: 'CANCELED' } },
        { name: 'cancelled por expiración', responses: [search([payment('cancelled', { status_detail: 'expired' })])], expect: { status: 'EXPIRED' } },
        { name: 'refunded', responses: [search([payment('refunded', { transaction_amount_refunded: 15000 })])], expect: { status: 'PAID', refundedAmount: 15000 } },
        { name: 'charged_back', responses: [search([payment('charged_back')])], expect: { status: 'PAID', refundedAmount: 15000 } },
    ],
    returns: [
        { name: 'aprobado: consulta el payment_id y compara orden y monto', request: getRequest(`${returnUrl}?collection_id=987654321&collection_status=approved&payment_id=987654321&status=approved&external_reference=ORD-MP-1&preference_id=${preferenceId}`), responses: [{ body: approved }], expect: 'PAID' },
        { name: 'rechazado', request: getRequest(`${returnUrl}?payment_id=987654321&status=rejected&external_reference=ORD-MP-1`), responses: [{ body: payment('rejected') }], expect: 'REJECTED' },
        { name: 'volver sin pagar (payment_id=null): busca por la orden', request: getRequest(`${returnUrl}?payment_id=null&status=null&external_reference=ORD-MP-1`), responses: [search([])], expect: 'PENDING' },
        { name: 'external_reference de otra orden', request: getRequest(`${returnUrl}?payment_id=1&external_reference=OTRA`), expect: 'RETURN_MISMATCH' },
        { name: 'el pago consultado es de otra orden', request: getRequest(`${returnUrl}?payment_id=555`), responses: [{ body: payment('approved', { id: 555, external_reference: 'OTRA' }) }], expect: 'RETURN_MISMATCH' },
        { name: 'el pago consultado tiene otro monto', request: getRequest(`${returnUrl}?payment_id=987654321`), responses: [{ body: payment('approved', { transaction_amount: 1 }) }], expect: 'RETURN_MISMATCH' },
    ],
});

describe('Mercado Pago Checkout Pro', () => {
    it('crea la preferencia con back_urls https, auto_return y redirige a init_point', async () => {
        const calls = mockFetch([{ body: { id: preferenceId, init_point: 'https://mp/init', sandbox_init_point: 'https://mp/sandbox' } }]);
        const created = await createPaymentAdapter({ provider: 'mercadopago', env }).create({
            orderId: 'ORD-MP-1',
            amount: 15000,
            returnUrl,
            notificationUrl: 'https://shop.example/webhooks/mercadopago',
            customer: { email: 'c@t.cl', name: 'Ana' },
            extras: { statementDescriptor: 'TIENDA', raw: { differential_pricing: { id: 1 } } },
        });
        expect(calls[0].url).toBe(`${MERCADOPAGO_API.baseUrl}/checkout/preferences`);
        expect(calls[0].headers.Authorization).toBe('Bearer APP_USR-test');
        expect(calls[0].json()).toMatchObject({
            external_reference: 'ORD-MP-1',
            items: [{ id: 'ORD-MP-1', quantity: 1, unit_price: 15000, currency_id: 'CLP' }],
            back_urls: { success: returnUrl, failure: returnUrl, pending: returnUrl },
            auto_return: 'approved',
            notification_url: 'https://shop.example/webhooks/mercadopago',
            payer: { email: 'c@t.cl', name: 'Ana' },
            statement_descriptor: 'TIENDA',
            differential_pricing: { id: 1 },
        });
        expect(created.redirectUrl).toBe('https://mp/init');
    });

    it('rechaza returnUrl http porque Mercado Pago la descarta', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'mercadopago', env }).create({ orderId: 'ORD-MP-1', amount: 15000, returnUrl: 'http://localhost/pago' }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'returnUrl' });
    });

    it('con el id de pago guardado consulta directo', async () => {
        const calls = mockFetch([{ body: approved }]);
        const result = await createPaymentAdapter({ provider: 'mercadopago', env }).getStatus({ ...ref, data: { ...ref.data, paymentId: '987654321' } });
        expect(calls[0].url).toBe(`${MERCADOPAGO_API.baseUrl}/v1/payments/987654321`);
        expect(result.status).toBe('PAID');
    });

    function signed(dataId: string, ts = Math.floor(Date.now() / 1000)) {
        const requestId = 'req-1';
        const v1 = hmacSha256Hex(env.webhookSecret, `id:${dataId};request-id:${requestId};ts:${ts};`);
        return postJson(
            `https://shop.example/webhooks/mercadopago?data.id=${dataId}&type=payment`,
            { id: 111, type: 'payment', action: 'payment.updated', data: { id: dataId } },
            { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
        );
    }

    it('verifica la firma del webhook y consulta el pago', async () => {
        const calls = mockFetch([{ body: approved }]);
        const notification = await createPaymentAdapter({ provider: 'mercadopago', env }).handleNotification(signed('987654321'));
        expect(calls[0].url).toBe(`${MERCADOPAGO_API.baseUrl}/v1/payments/987654321`);
        expect(notification).toMatchObject({ eventId: '111', reply: { status: 200 }, result: { status: 'PAID', ref: { orderId: 'ORD-MP-1' } } });
    });

    it('rechaza una firma inválida sin consultar', async () => {
        const calls = mockFetch([]);
        const request = signed('987654321');
        request.headers['x-signature'] = 'ts=1,v1=deadbeef';
        await expect(createPaymentAdapter({ provider: 'mercadopago', env }).handleNotification(request)).rejects.toMatchObject({
            code: 'VERIFICATION_FAILED',
        });
        expect(calls).toHaveLength(0);
    });

    it('sin webhookSecret no verifica', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'mercadopago', env: { accessToken: 'x' } }).handleNotification(signed('1')),
        ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    });

    it('otros tipos de evento responden 200 sin resultado', async () => {
        const calls = mockFetch([]);
        const ts = Math.floor(Date.now() / 1000);
        const v1 = hmacSha256Hex(env.webhookSecret, `id:5;request-id:r;ts:${ts};`);
        const notification = await createPaymentAdapter({ provider: 'mercadopago', env }).handleNotification(
            postJson('https://shop.example/webhooks/mercadopago?data.id=5&type=merchant_order', { id: 2, type: 'merchant_order', data: { id: 5 } }, { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r' }),
        );
        expect(notification.result).toBeUndefined();
        expect(notification.reply.status).toBe(200);
        expect(calls).toHaveLength(0);
    });

    it('reembolsa con X-Idempotency-Key y monto parcial', async () => {
        const calls = mockFetch([{ body: { id: 55, payment_id: 987654321, amount: 5000, status: 'approved' } }]);
        const refund = await createPaymentAdapter({ provider: 'mercadopago', env }).refund(
            { ...ref, data: { ...ref.data, paymentId: '987654321' } },
            { refundId: 'rf-mp-1', amount: 5000 },
        );
        expect(calls[0].url).toBe(`${MERCADOPAGO_API.baseUrl}/v1/payments/987654321/refunds`);
        expect(calls[0].headers['X-Idempotency-Key']).toBe('rf-mp-1');
        expect(calls[0].json()).toEqual({ amount: 5000 });
        expect(refund).toMatchObject({ status: 'SUCCEEDED', amount: 5000, refund: { providerRefundId: '55' } });
    });

    it('cancela solo un pago pendiente', async () => {
        const calls = mockFetch([search([payment('pending')]), { body: payment('cancelled', { status_detail: 'by_collector' }) }]);
        const result = await createPaymentAdapter({ provider: 'mercadopago', env }).cancel(ref);
        expect(calls[1].method).toBe('PUT');
        expect(calls[1].json()).toEqual({ status: 'cancelled' });
        expect(result.status).toBe('CANCELED');
    });

    it('no cancela un pago aprobado', async () => {
        mockFetch([search([approved])]);
        await expect(createPaymentAdapter({ provider: 'mercadopago', env }).cancel(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});
