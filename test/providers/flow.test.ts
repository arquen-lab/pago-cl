import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { FLOW_API } from '../../src/providers/flow/api';
import { FlowCore } from '../../src/providers/flow/core';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { mockFetch, postForm } from '../helpers/fetch';

const env = { apiKey: 'flow-key', secretKey: 'flow-secret', environment: 'sandbox' as const, notificationUrl: 'https://shop.example/webhooks/flow' };
const token = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';
const ref: PaymentRef = { provider: 'flow', orderId: 'ORD-FLOW-1', transactionId: token, data: { flowOrder: 123456, amount: 15000, currency: 'CLP', email: 'cliente@shop.example' } };
const returnUrl = 'https://shop.example/pago/ORD-FLOW-1';

function statusBody(status: number, extra: Record<string, unknown> = {}) {
    return { flowOrder: 123456, commerceOrder: 'ORD-FLOW-1', status, subject: 'Orden', currency: 'CLP', amount: 15000, payer: 'cliente@shop.example', ...extra };
}
const paid = statusBody(2, { paymentData: { date: '2026-09-30 10:00:00', media: 'webpay', amount: 15000, currency: 'CLP', fee: 500, balance: 14500 } });

describeCheckoutContract('flow', {
    adapter: () => createPaymentAdapter({ provider: 'flow', env }),
    adapterWithoutDefaultUrl: () => createPaymentAdapter({ provider: 'flow', env: { ...env, notificationUrl: undefined } }),
    createInput: { orderId: 'ORD-FLOW-1', amount: 15000, returnUrl, customer: { email: 'cliente@shop.example' } },
    createResponse: { body: { url: 'https://sandbox.flow.cl/app/web/pay.php', token, flowOrder: 123456 } },
    createdTransactionId: token,
    ref,
    paidResponse: { body: paid },
    statuses: [
        { name: '1 pendiente', responses: [{ body: statusBody(1) }], expect: { status: 'PENDING' } },
        { name: '2 pagada', responses: [{ body: paid }], expect: { status: 'PAID', amount: 15000 } },
        { name: '3 rechazada', responses: [{ body: statusBody(3) }], expect: { status: 'REJECTED' } },
        { name: '4 anulada', responses: [{ body: statusBody(4) }], expect: { status: 'CANCELED' } },
    ],
    returns: [
        { name: 'POST con token: consulta y queda PAID', request: postForm(returnUrl, { token }), responses: [{ body: paid }], expect: 'PAID' },
        { name: 'POST con token de una orden pendiente', request: postForm(returnUrl, { token }), responses: [{ body: statusBody(1) }], expect: 'PENDING' },
        { name: 'token de otra orden', request: postForm(returnUrl, { token: 'OTRO' }), expect: 'RETURN_MISMATCH' },
        { name: 'sin token: consulta con el de la ref', request: postForm(returnUrl, {}), responses: [{ body: statusBody(4) }], expect: 'CANCELED' },
    ],
});

describe('Flow', () => {
    it('exige email del cliente', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'flow', env }).create({ orderId: 'ORD-FLOW-1', amount: 15000, returnUrl }),
        ).rejects.toMatchObject({ code: 'MISSING_FIELD', field: 'customer.email' });
    });

    it('exige notificationUrl cuando el env no trae una por defecto', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'flow', env: { ...env, notificationUrl: undefined } }).create({
                orderId: 'ORD-FLOW-1',
                amount: 15000,
                returnUrl,
                customer: { email: 'c@t.cl' },
            }),
        ).rejects.toMatchObject({ code: 'MISSING_FIELD', field: 'notificationUrl' });
    });

    it('firma el body, sufija la URL de confirmación y arma optional con nombre, rut y metadata', async () => {
        const calls = mockFetch([{ body: { url: 'https://sandbox.flow.cl/app/web/pay.php', token, flowOrder: 1 } }]);
        await createPaymentAdapter({ provider: 'flow', env }).create({
            orderId: 'ORD-FLOW-1',
            amount: 15000,
            currency: 'UF',
            returnUrl,
            customer: { email: 'cliente@shop.example', name: 'Ana', taxId: '1-9' },
            metadata: { carro: 'c1' },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });
        const params = Object.fromEntries(new URLSearchParams(calls[0].body));
        expect(calls[0].url).toBe(`${FLOW_API.hosts.sandbox}/payment/create`);
        expect(params.urlConfirmation).toBe('https://shop.example/webhooks/flow?kind=payment');
        expect(params.urlReturn).toBe(returnUrl);
        expect(params.currency).toBe('UF');
        expect(JSON.parse(params.optional)).toEqual({ carro: 'c1', nombre: 'Ana', rut: '1-9' });
        expect(Number(params.timeout)).toBeGreaterThan(800);
        const { s, ...rest } = params;
        expect(s).toBe(new FlowCore(env).sign(rest));
    });

    it('la notificación de pago reconsulta con el token y trae la orden', async () => {
        const calls = mockFetch([{ body: paid }]);
        const notification = await createPaymentAdapter({ provider: 'flow', env }).handleNotification(
            postForm('https://shop.example/webhooks/flow?kind=payment', { token }),
        );
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toContain('/payment/getStatus?');
        expect(notification.reply.status).toBe(200);
        expect(notification.result).toMatchObject({ status: 'PAID', ref: { orderId: 'ORD-FLOW-1', transactionId: token } });
    });

    it('la notificación de reembolso consulta refund/getStatus', async () => {
        const calls = mockFetch([{ body: { token: 'RT', flowRefundOrder: 9, status: 'refunded', amount: 5000 } }]);
        const notification = await createPaymentAdapter({ provider: 'flow', env }).handleNotification(
            postForm('https://shop.example/webhooks/flow?kind=refund', { token: 'RT' }),
        );
        expect(calls[0].url).toContain('/refund/getStatus?');
        expect(notification.refund).toMatchObject({ status: 'SUCCEEDED', amount: 5000 });
    });

    it('sin token responde 400', async () => {
        mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'flow', env }).handleNotification(postForm('https://shop.example/webhooks/flow', {}));
        expect(notification.reply.status).toBe(400);
        expect(notification.result).toBeUndefined();
    });

    it('el reembolso usa refundId como refundCommerceOrder, el email guardado y nace PENDING', async () => {
        const calls = mockFetch([{ body: { token: 'RT', flowRefundOrder: 9, status: 'created', amount: 5000 } }]);
        const refund = await createPaymentAdapter({ provider: 'flow', env }).refund(ref, { refundId: 'rf-1', amount: 5000 });
        const params = Object.fromEntries(new URLSearchParams(calls[0].body));
        expect(params).toMatchObject({
            refundCommerceOrder: 'rf-1',
            receiverEmail: 'cliente@shop.example',
            amount: '5000',
            urlCallBack: 'https://shop.example/webhooks/flow?kind=refund',
            flowTrxId: '123456',
        });
        expect(refund).toMatchObject({ status: 'PENDING', refund: { providerRefundId: 'RT' } });
    });

    it('no se puede consultar por otra pasarela el ref de flow', async () => {
        mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'venti', env: { apiKey: 'key_test_x' } }).getStatus(ref)).rejects.toMatchObject({
            code: 'INVALID_INPUT',
        });
    });
});
