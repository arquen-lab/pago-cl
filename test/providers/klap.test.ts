import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { sha256Hex } from '../../src/core/webhooks';
import { KLAP_API } from '../../src/providers/klap/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch } from '../helpers/fetch';

const env = { apiKey: 'klap-key', notificationUrl: 'https://shop.example/webhooks/klap' };
const orderId = '1M1b90c9cd80452eddb41f09d6';
const ref: PaymentRef = { provider: 'klap', orderId: 'ORD-KLAP-1', transactionId: orderId, data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-KLAP-1';

function order(status: string, extra: Record<string, unknown> = {}) {
    return {
        order_id: orderId,
        reference_id: 'ORD-KLAP-1',
        status,
        amount: { currency: 'CLP', total: 15000 },
        selected_method: status === 'completed' ? { code: 'MP1', name: 'tarjetas' } : null,
        redirect_url: 'https://pagos-pasarela-sandbox.mcdesaqa.cl/order/abc',
        ...extra,
    };
}
const completed = order('completed');
// Respuesta real del sandbox para un pago aprobado que el comercio no confirmó (webhook inalcanzable).
const unconfirmedReversal = order('refund', {
    payment_details: [
        { key: 'brand', value: 'VISA' },
        { key: 'card_type', value: 'CREDITO' },
        { key: 'last_digits', value: '1000' },
        { key: 'approval_code', value: '831347' },
        { key: 'code', value: '100100' },
        { key: 'message', value: 'Transacción no realizada. Se hará la reversa del cargo.' },
    ],
});

describeCheckoutContract('klap', {
    adapter: () => createPaymentAdapter({ provider: 'klap', env }),
    adapterWithoutDefaultUrl: () => createPaymentAdapter({ provider: 'klap', env: { ...env, notificationUrl: undefined } }),
    createInput: { orderId: 'ORD-KLAP-1', amount: 15000, returnUrl },
    createResponse: { status: 201, body: order('pending') },
    createdTransactionId: orderId,
    ref,
    paidResponse: { body: completed },
    statuses: [
        { name: 'pending', responses: [{ body: order('pending') }], expect: { status: 'PENDING', amount: 15000 } },
        { name: 'completed', responses: [{ body: completed }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'canceled', responses: [{ body: order('canceled') }], expect: { status: 'CANCELED' } },
        { name: 'expired', responses: [{ body: order('expired') }], expect: { status: 'EXPIRED' } },
        { name: 'refund (reversa automática o reembolso)', responses: [{ body: order('refund') }], expect: { status: 'PAID', refundedAmount: 15000 } },
    ],
    returns: [
        { name: 'return_url: consulta la orden', request: getRequest(returnUrl), responses: [{ body: completed }], expect: 'PAID' },
        { name: 'cancel_url: la orden sigue pendiente', request: getRequest(returnUrl), responses: [{ body: order('pending') }], expect: 'PENDING' },
        { name: 'cancel_url con la orden cancelada', request: getRequest(returnUrl), responses: [{ body: order('canceled') }], expect: 'CANCELED' },
        { name: 'la orden consultada es de otra referencia', request: getRequest(returnUrl), responses: [{ body: order('completed', { reference_id: 'OTRA' }) }], expect: 'RETURN_MISMATCH' },
    ],
});

describe('Klap Checkout', () => {
    it('rechaza una notificationUrl local: Klap no puede entregar el webhook y reversa el cargo', async () => {
        const calls = mockFetch([]);
        const adapter = createPaymentAdapter({ provider: 'klap', env });
        for (const url of ['https://pago.localhost:1355/webhooks/klap', 'http://localhost:3000/hook', 'https://127.0.0.1/hook']) {
            await expect(adapter.create({ orderId: 'ORD-KLAP-1', amount: 15000, returnUrl, notificationUrl: url })).rejects.toMatchObject({
                code: 'INVALID_INPUT',
                field: 'notificationUrl',
            });
        }
        expect(calls).toHaveLength(0);
    });

    it('un pago aprobado que no se confirmó (reversa 100100) es CANCELED, sin reembolso, con el motivo', async () => {
        mockFetch([{ body: unconfirmedReversal }]);
        const result = await createPaymentAdapter({ provider: 'klap', env }).getStatus(ref);
        expect(result).toMatchObject({
            status: 'CANCELED',
            final: true,
            refundedAmount: 0,
            authorizationCode: '831347',
            paymentMethod: 'VISA CREDITO 1000',
            providerStatus: 'refund:100100',
            statusDetail: 'Transacción no realizada. Se hará la reversa del cargo.',
        });
    });

    it('lee payment_details de un pago confirmado: autorización y tarjeta', async () => {
        mockFetch([{ body: order('completed', { payment_details: [{ key: 'approval_code', value: '555111' }, { key: 'brand', value: 'MASTERCARD' }, { key: 'last_digits', value: '3758' }] }) }]);
        const result = await createPaymentAdapter({ provider: 'klap', env }).getStatus(ref);
        expect(result).toMatchObject({ status: 'PAID', authorizationCode: '555111', paymentMethod: 'MASTERCARD 3758' });
    });

    it('exige notificationUrl: Klap pide los dos webhooks', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'klap', env: { apiKey: 'k' } }).create({ orderId: 'ORD-KLAP-1', amount: 15000, returnUrl }),
        ).rejects.toMatchObject({ code: 'MISSING_FIELD', field: 'notificationUrl' });
    });

    it('valida el rango de monto de Klap', async () => {
        mockFetch([]);
        const adapter = createPaymentAdapter({ provider: 'klap', env });
        await expect(adapter.create({ orderId: 'ORD-KLAP-1', amount: 10, returnUrl })).rejects.toMatchObject({ field: 'amount' });
        await expect(adapter.create({ orderId: 'ORD-KLAP-1', amount: 100_000_000, returnUrl })).rejects.toMatchObject({ field: 'amount' });
    });

    it('crea la orden con apikey, webhooks confirm y reject, customs y usuario', async () => {
        const calls = mockFetch([{ status: 201, body: order('pending') }]);
        await createPaymentAdapter({ provider: 'klap', env }).create({
            orderId: 'ORD-KLAP-1',
            amount: 15000,
            description: 'Cobro',
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            customer: { email: 'a@b.cl', name: 'Ana Pérez', taxId: '11111111-1' },
            expiresAt: new Date(Date.now() + 30 * 60_000),
            metadata: { notify_payment_user: 'true' },
            extras: { methods: ['tarjetas'], quotasAllowed: '2-6' },
        });
        expect(calls[0].url).toBe(`${KLAP_API.hosts.sandbox}/payment-gateway/v1/orders`);
        expect(calls[0].headers.apikey).toBe('klap-key');
        expect(calls[0].json()).toEqual({
            reference_id: 'ORD-KLAP-1',
            user: { email: 'a@b.cl', rut: '11111111-1', first_name: 'Ana', last_name: 'Pérez' },
            amount: { currency: 'CLP', total: 15000 },
            methods: ['tarjetas'],
            description: 'Cobro',
            customs: [
                { key: 'tarjetas_expiration_minutes', value: '30' },
                { key: 'tarjetas_quotas_allowed', value: '2-6' },
                { key: 'notify_payment_user', value: 'true' },
            ],
            urls: { return_url: returnUrl, cancel_url: 'https://shop.example/cancel' },
            webhooks: {
                webhook_confirm: 'https://shop.example/webhooks/klap?kind=confirm',
                webhook_reject: 'https://shop.example/webhooks/klap?kind=reject',
            },
        });
    });

    it('rejectNotificationUrl cambia solo el webhook de rechazo y conserva ?kind=reject', async () => {
        const calls = mockFetch([{ status: 201, body: order('pending') }]);
        await createPaymentAdapter({ provider: 'klap', env }).create({
            orderId: 'ORD-KLAP-1',
            amount: 15000,
            returnUrl,
            extras: { rejectNotificationUrl: 'https://shop.example/webhooks/klap-rechazos' },
        });
        expect(calls[0].json()).toMatchObject({
            webhooks: {
                webhook_confirm: 'https://shop.example/webhooks/klap?kind=confirm',
                webhook_reject: 'https://shop.example/webhooks/klap-rechazos?kind=reject',
            },
        });
    });

    it('rejectNotificationUrl local también se rechaza', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'klap', env }).create({
                orderId: 'ORD-KLAP-1',
                amount: 15000,
                returnUrl,
                extras: { rejectNotificationUrl: 'http://localhost:3000/rechazos' },
            }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'extras.rejectNotificationUrl' });
    });

    it('por defecto usa todos los medios y la URL de retorno como cancelación', async () => {
        const calls = mockFetch([{ status: 201, body: order('pending') }]);
        await createPaymentAdapter({ provider: 'klap', env }).create({ orderId: 'ORD-KLAP-1', amount: 15000, returnUrl });
        expect(calls[0].json()).toMatchObject({
            methods: ['*'],
            urls: { return_url: returnUrl, cancel_url: returnUrl },
            // el sandbox responde 404007/400009 si falta la expiración de cualquiera de los tres medios
            customs: [
                { key: 'tarjetas_expiration_minutes', value: '30' },
                { key: 'sodexo_expiration_minutes', value: '30' },
                { key: 'edenred_expiration_minutes', value: '30' },
            ],
        });
    });

    it('un error {code, message} llega al mensaje y al providerCode', async () => {
        mockFetch([{ status: 400, body: { code: '400001', message: 'Empty response.' } }]);
        await expect(createPaymentAdapter({ provider: 'klap', env }).getStatus(ref)).rejects.toMatchObject({
            code: 'PROVIDER_ERROR',
            message: 'Klap: Empty response.',
            provider: { providerCode: '400001', httpStatus: 400 },
        });
    });

    it('reembolso total sin monto y parcial con monto', async () => {
        const calls = mockFetch([
            { status: 201, body: { order_id: orderId, type: 'refund', amount: 15000, refundable_amount: 0, status: 'refunded', mc_code: '969726367' } },
            { status: 201, body: { order_id: orderId, type: 'partial_refund', amount: 5000, refundable_amount: 10000, status: 'refunded' } },
        ]);
        const adapter = createPaymentAdapter({ provider: 'klap', env });
        const total = await adapter.refund(ref, { refundId: 'rf-1' });
        expect(calls[0].url).toBe(`${KLAP_API.hosts.sandbox}/payment-gateway/v1/orders/${orderId}/refund`);
        expect(calls[0].json()).toEqual({});
        expect(total).toMatchObject({ status: 'SUCCEEDED', amount: 15000, refundableAmount: 0, refund: { providerRefundId: '969726367' } });
        const partial = await adapter.refund(ref, { refundId: 'rf-2', amount: 5000 });
        expect(calls[1].json()).toEqual({ amount: 5000 });
        expect(partial).toMatchObject({ status: 'SUCCEEDED', amount: 5000, refundableAmount: 10000 });
    });

    function webhook(kind: 'confirm' | 'reject', body: Record<string, unknown>, apikey = env.apiKey, signed = true) {
        const reference = String(body.reference_id);
        const id = String(body.order_id);
        return {
            method: 'POST',
            url: `https://shop.example/webhooks/klap?kind=${kind}`,
            headers: { 'content-type': 'application/json', ...(signed ? { Apikey: sha256Hex(`${reference}${id}${apikey}`) } : {}) },
            body: JSON.stringify(body),
        };
    }
    const confirmBody = { order_id: orderId, reference_id: 'ORD-KLAP-1', mc_code: '91856202', card_type: 'DEBIT', last_digits: '4105', brand: 'VISA' };

    it('el webhook de confirmación es el commit: PAID desde el evento y ACK JSON', async () => {
        const calls = mockFetch([{ body: completed }]);
        const notification = await createPaymentAdapter({ provider: 'klap', env }).handleNotification(webhook('confirm', confirmBody));
        expect(notification.reply).toMatchObject({ status: 200, body: '{"status":"ok"}', headers: { 'content-type': 'application/json' } });
        expect(notification.eventId).toBe(`confirm:${orderId}`);
        expect(notification.result).toMatchObject({
            status: 'PAID',
            final: true,
            amount: 15000,
            ref: { orderId: 'ORD-KLAP-1', transactionId: orderId },
            authorizationCode: '91856202',
            paymentMethod: 'VISA DEBIT 4105',
        });
        expect(calls[0].method).toBe('GET');
    });

    it('el monto del evento evita la consulta', async () => {
        const calls = mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'klap', env }).handleNotification(webhook('confirm', { ...confirmBody, amount: 15000 }));
        expect(notification.result?.amount).toBe(15000);
        expect(calls).toHaveLength(0);
    });

    it('si la consulta del monto falla, igual responde el ACK', async () => {
        mockFetch([{ status: 500, text: 'boom' }]);
        const notification = await createPaymentAdapter({ provider: 'klap', env }).handleNotification(webhook('confirm', confirmBody));
        expect(notification.reply.status).toBe(200);
        expect(notification.result).toMatchObject({ status: 'PAID', amount: 0 });
    });

    it('el webhook de rechazo deja REJECTED', async () => {
        const notification = await createPaymentAdapter({ provider: 'klap', env }).handleNotification(
            webhook('reject', { order_id: orderId, reference_id: 'ORD-KLAP-1', code: '51', message: 'fondos insuficientes' }),
        );
        expect(notification.reply.status).toBe(200);
        expect(notification.result).toMatchObject({ status: 'REJECTED', final: true, providerStatus: 'rejected:51' });
    });

    it('rechaza un webhook con el hash de otra clave', async () => {
        const calls = mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'klap', env }).handleNotification(webhook('confirm', confirmBody, 'otra'))).rejects.toMatchObject({
            code: 'VERIFICATION_FAILED',
        });
        expect(calls).toHaveLength(0);
    });

    it('rechaza un webhook sin el header Apikey', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'klap', env }).handleNotification(webhook('confirm', confirmBody, env.apiKey, false)),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('un webhook sin kind responde 400', async () => {
        mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'klap', env }).handleNotification({
            method: 'POST',
            url: 'https://shop.example/webhooks/klap',
            headers: {},
            body: JSON.stringify(confirmBody),
        });
        expect(notification.reply.status).toBe(400);
        expect(notification.result).toBeUndefined();
    });
});
