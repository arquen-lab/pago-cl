import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { hmacSha256Hex } from '../../src/core/webhooks';
import { FINTOC_API } from '../../src/providers/fintoc/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch } from '../helpers/fetch';

const env = { secretKey: 'sk_test_fintoc', webhookSecret: 'whsec_fintoc' };
const sessionId = 'cs_li5531onlFDi235';
const intentId = 'pi_BO381oEATXonG6bj';
const ref: PaymentRef = { provider: 'fintoc', orderId: 'ORD-FINTOC-1', transactionId: sessionId, data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-FINTOC-1';

function intent(status: string, extra: Record<string, unknown> = {}) {
    return {
        id: intentId,
        object: 'payment_intent',
        amount: 15000,
        currency: 'CLP',
        status,
        error_reason: null,
        payment_type: 'bank_transfer',
        reference_id: status === 'succeeded' ? '123456789' : null,
        sender_account: { holder_id: '111111111', institution_id: 'cl_banco_falabella', number: '0000000000', type: 'checking_account' },
        transaction_date: status === 'succeeded' ? '2026-09-30T18:50:25Z' : null,
        ...extra,
    };
}
function session(status: string, paymentIntent: ReturnType<typeof intent> | null = null, extra: Record<string, unknown> = {}) {
    return {
        id: sessionId,
        object: 'checkout_session',
        amount: 15000,
        currency: 'CLP',
        flow: 'payment',
        status,
        metadata: { order_id: 'ORD-FINTOC-1' },
        payment_resource: paymentIntent ? { payment_intent: paymentIntent } : null,
        redirect_url: `https://checkout.fintoc.com/payment?checkout_session=${sessionId}`,
        ...extra,
    };
}
const paid = session('finished', intent('succeeded'));

describeCheckoutContract('fintoc', {
    adapter: () => createPaymentAdapter({ provider: 'fintoc', env }),
    createInput: { orderId: 'ORD-FINTOC-1', amount: 15000, returnUrl },
    createResponse: { status: 201, body: session('created') },
    createdTransactionId: sessionId,
    ref,
    paidResponse: { body: paid },
    statuses: [
        { name: 'created sin intento de pago', responses: [{ body: session('created') }], expect: { status: 'PENDING', amount: 15000 } },
        { name: 'in_progress con intent in_progress', responses: [{ body: session('in_progress', intent('in_progress')) }], expect: { status: 'PENDING' } },
        { name: 'intent pending (el banco confirma)', responses: [{ body: session('in_progress', intent('pending')) }], expect: { status: 'PENDING' } },
        { name: 'finished con el intent aún en requires_action', responses: [{ body: session('finished', intent('requires_action')) }], expect: { status: 'PENDING' } },
        { name: 'finished con intent succeeded', responses: [{ body: paid }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'intent failed', responses: [{ body: session('in_progress', intent('failed', { error_reason: 'insufficient_funds' })) }], expect: { status: 'REJECTED' } },
        { name: 'intent rejected', responses: [{ body: session('in_progress', intent('rejected')) }], expect: { status: 'REJECTED' } },
        { name: 'sesión expirada sin pago', responses: [{ body: session('expired') }], expect: { status: 'EXPIRED' } },
        { name: 'sesión expirada con intent expired', responses: [{ body: session('expired', intent('expired')) }], expect: { status: 'EXPIRED' } },
        { name: 'sesión expirada con un intent aún en curso', responses: [{ body: session('expired', intent('created')) }], expect: { status: 'EXPIRED' } },
    ],
    returns: [
        { name: 'success_url: consulta la sesión y queda PAID', request: getRequest(returnUrl), responses: [{ body: paid }], expect: 'PAID' },
        { name: 'success_url antes de que el banco confirme', request: getRequest(returnUrl), responses: [{ body: session('finished', intent('pending')) }], expect: 'PENDING' },
        { name: 'cancel_url: el pagador no completó', request: getRequest(returnUrl), responses: [{ body: session('created') }], expect: 'PENDING' },
        { name: 'cancel_url con la sesión expirada', request: getRequest(returnUrl), responses: [{ body: session('expired') }], expect: 'EXPIRED' },
        { name: 'la sesión es de otra orden', request: getRequest(returnUrl), responses: [{ body: session('finished', intent('succeeded'), { metadata: { order_id: 'OTRA' } }) }], expect: 'RETURN_MISMATCH' },
    ],
});

describe('Fintoc Checkout', () => {
    it('crea la sesión con Authorization sin Bearer, URLs, id de orden en metadata y email', async () => {
        const calls = mockFetch([{ status: 201, body: session('created') }]);
        const expiresAt = new Date(Date.now() + 3600_000);
        const created = await createPaymentAdapter({ provider: 'fintoc', env }).create({
            orderId: 'ORD-FINTOC-1',
            amount: 15000,
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            customer: { email: 'a@b.cl' },
            expiresAt,
            metadata: { carro: 'c1' },
            extras: { paymentMethodTypes: ['bank_transfer'] },
        });
        expect(calls[0].url).toBe(`${FINTOC_API.baseUrl}/v2/checkout_sessions`);
        expect(calls[0].headers.Authorization).toBe('sk_test_fintoc');
        expect(calls[0].headers).not.toHaveProperty('Fintoc-Version');
        expect(calls[0].json()).toEqual({
            currency: 'CLP',
            amount: 15000,
            success_url: returnUrl,
            cancel_url: 'https://shop.example/cancel',
            customer_email: 'a@b.cl',
            expires_at: expiresAt.toISOString(),
            metadata: { carro: 'c1', order_id: 'ORD-FINTOC-1' },
            payment_method_types: ['bank_transfer'],
        });
        expect(created.redirectUrl).toBe(`https://checkout.fintoc.com/payment?checkout_session=${sessionId}`);
    });

    it('envía Fintoc-Version solo si se configura, y usa la URL de retorno como cancelación por defecto', async () => {
        const calls = mockFetch([{ status: 201, body: session('created') }]);
        await createPaymentAdapter({ provider: 'fintoc', env: { ...env, apiVersion: '2026-02-01' } }).create({ orderId: 'ORD-FINTOC-1', amount: 15000, returnUrl });
        expect(calls[0].headers['Fintoc-Version']).toBe('2026-02-01');
        expect(calls[0].json()).toMatchObject({ cancel_url: returnUrl });
    });

    it('exige al menos 10 minutos de vigencia', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'fintoc', env }).create({ orderId: 'ORD-FINTOC-1', amount: 15000, returnUrl, expiresAt: new Date(Date.now() + 60_000) }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'expiresAt' });
    });

    it('un pago aprobado informa el n° de operación, el banco y guarda el payment_intent', async () => {
        mockFetch([{ body: paid }]);
        const result = await createPaymentAdapter({ provider: 'fintoc', env }).getStatus(ref);
        expect(result).toMatchObject({
            status: 'PAID',
            authorizationCode: '123456789',
            paymentMethod: 'bank_transfer cl_banco_falabella',
            providerStatus: 'finished:succeeded',
            ref: { data: { paymentIntentId: intentId } },
        });
    });

    it('un pago fallido trae el motivo en statusDetail', async () => {
        mockFetch([{ body: session('in_progress', intent('failed', { error_reason: 'insufficient_funds' })) }]);
        const result = await createPaymentAdapter({ provider: 'fintoc', env }).getStatus(ref);
        expect(result).toMatchObject({ status: 'REJECTED', statusDetail: 'insufficient_funds', providerStatus: 'in_progress:failed' });
    });

    it('cancela expirando la sesión y la deja CANCELED', async () => {
        const calls = mockFetch([{ status: 201, body: session('expired') }]);
        const result = await createPaymentAdapter({ provider: 'fintoc', env }).cancel(ref);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toBe(`${FINTOC_API.baseUrl}/v2/checkout_sessions/${sessionId}/expire`);
        expect(result).toMatchObject({ status: 'CANCELED', final: true, providerStatus: 'expired' });
    });

    it('un error {error:{code,message}} llega al mensaje y al providerCode', async () => {
        mockFetch([{ status: 401, body: { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API Key: sk_te*****', doc_url: 'https://docs.fintoc.com/reference/errors' } } }]);
        await expect(createPaymentAdapter({ provider: 'fintoc', env }).getStatus(ref)).rejects.toMatchObject({
            code: 'PROVIDER_ERROR',
            message: 'Fintoc: Invalid API Key: sk_te*****',
            provider: { httpStatus: 401, providerCode: 'invalid_api_key', retryable: false },
        });
    });

    it('un error con param lo agrega al mensaje', async () => {
        mockFetch([{ status: 400, body: { error: { type: 'invalid_request_error', message: 'must be at least 10 minutes in the future', param: 'expires_at' } } }]);
        await expect(createPaymentAdapter({ provider: 'fintoc', env }).getStatus(ref)).rejects.toMatchObject({
            message: 'Fintoc: must be at least 10 minutes in the future (expires_at)',
        });
    });

    it('devolución total: usa el payment_intent que aprendió al consultar y nace created', async () => {
        const calls = mockFetch([
            { body: paid },
            { status: 201, body: { id: 're_1', object: 'refund', amount: 15000, currency: 'CLP', status: 'created', resource_id: intentId, resource_type: 'payment_intent' } },
        ]);
        const refund = await createPaymentAdapter({ provider: 'fintoc', env }).refund(ref, { refundId: 'rf-1' });
        expect(calls[1].url).toBe(`${FINTOC_API.baseUrl}/v1/refunds`);
        expect(calls[1].json()).toEqual({ resource_id: intentId, resource_type: 'payment_intent', metadata: { refund_id: 'rf-1' } });
        expect(refund).toMatchObject({ status: 'PENDING', amount: 15000, providerStatus: 'created', refund: { providerRefundId: 're_1', refundId: 'rf-1' } });
    });

    it('devolución parcial con el payment_intent ya guardado en la ref, sin consultar', async () => {
        const calls = mockFetch([{ status: 201, body: { id: 're_2', amount: 5000, status: 'created' } }]);
        await createPaymentAdapter({ provider: 'fintoc', env }).refund({ ...ref, data: { ...ref.data, paymentIntentId: intentId } }, { refundId: 'rf-2', amount: 5000 });
        expect(calls).toHaveLength(1);
        expect(calls[0].json()).toMatchObject({ resource_id: intentId, amount: 5000 });
    });

    it('no se reembolsa una sesión sin pago', async () => {
        mockFetch([{ body: session('created') }]);
        await expect(createPaymentAdapter({ provider: 'fintoc', env }).refund(ref, { refundId: 'rf-3' })).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'ref' });
    });

    it('getRefund mapea cada estado y el motivo de fallo', async () => {
        mockFetch([
            { body: { id: 're_1', amount: 15000, status: 'in_progress' } },
            { body: { id: 're_1', amount: 15000, status: 'succeeded' } },
            { body: { id: 're_1', amount: 15000, status: 'failed', failure_code: 'insufficient_funds' } },
            { body: { id: 're_1', amount: 15000, status: 'canceled' } },
        ]);
        const adapter = createPaymentAdapter({ provider: 'fintoc', env });
        const refundRef = { provider: 'fintoc', refundId: 'rf-1', providerRefundId: 're_1', payment: ref };
        expect((await adapter.getRefund(refundRef)).status).toBe('PENDING');
        expect((await adapter.getRefund(refundRef)).status).toBe('SUCCEEDED');
        expect(await adapter.getRefund(refundRef)).toMatchObject({ status: 'FAILED', statusDetail: 'insufficient_funds' });
        expect((await adapter.getRefund(refundRef)).status).toBe('CANCELED');
    });

    function event(type: string, data: unknown, secret = env.webhookSecret, t = Math.floor(Date.now() / 1000)) {
        const body = JSON.stringify({ id: `evt_${type}`, object: 'event', type, mode: 'test', created_at: '2026-09-30T18:50:30Z', data });
        return {
            method: 'POST',
            url: 'https://shop.example/webhooks/fintoc',
            headers: { 'content-type': 'application/json', 'Fintoc-Signature': `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}` },
            body,
        };
    }

    it('checkout_session.finished: verifica la firma y entrega el resultado con el id de orden de metadata', async () => {
        const calls = mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'fintoc', env }).handleNotification(event('checkout_session.finished', paid));
        expect(calls).toHaveLength(0);
        expect(notification.reply).toMatchObject({ status: 200, body: '{"received":true}' });
        expect(notification.eventId).toBe('evt_checkout_session.finished');
        expect(notification.result).toMatchObject({ status: 'PAID', final: true, ref: { orderId: 'ORD-FINTOC-1', transactionId: sessionId } });
    });

    it('checkout_session.expired deja EXPIRED', async () => {
        const notification = await createPaymentAdapter({ provider: 'fintoc', env }).handleNotification(event('checkout_session.expired', session('expired')));
        expect(notification.result).toMatchObject({ status: 'EXPIRED' });
    });

    it('una sesión sin order_id en metadata responde 200 sin resultado', async () => {
        const notification = await createPaymentAdapter({ provider: 'fintoc', env }).handleNotification(event('checkout_session.finished', { ...paid, metadata: {} }));
        expect(notification.reply.status).toBe(200);
        expect(notification.result).toBeUndefined();
    });

    it('payment_intent.* y otros eventos responden 200 sin resultado', async () => {
        const adapter = createPaymentAdapter({ provider: 'fintoc', env });
        for (const type of ['payment_intent.succeeded', 'invoice.paid', 'payout.created']) {
            const notification = await adapter.handleNotification(event(type, intent('succeeded')));
            expect(notification.reply.status).toBe(200);
            expect(notification.result).toBeUndefined();
        }
    });

    it('refund.succeeded entrega el RefundResult con el refund_id de metadata', async () => {
        const notification = await createPaymentAdapter({ provider: 'fintoc', env }).handleNotification(
            event('refund.succeeded', { id: 're_1', amount: 15000, status: 'succeeded', resource_id: intentId, metadata: { refund_id: 'rf-1' } }),
        );
        expect(notification.refund).toMatchObject({ status: 'SUCCEEDED', amount: 15000, refund: { refundId: 'rf-1', providerRefundId: 're_1' } });
        expect(notification.result).toBeUndefined();
    });

    it('rechaza firma con otro secreto, firma vencida, sin cabecera, y cuerpo alterado', async () => {
        const adapter = createPaymentAdapter({ provider: 'fintoc', env });
        mockFetch([]);
        await expect(adapter.handleNotification(event('checkout_session.finished', paid, 'otro'))).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
        await expect(adapter.handleNotification(event('checkout_session.finished', paid, env.webhookSecret, Math.floor(Date.now() / 1000) - 3600))).rejects.toMatchObject({
            message: expect.stringContaining('expiró'),
        });
        await expect(adapter.handleNotification({ method: 'POST', url: '/', headers: {}, body: '{}' })).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
        const tampered = event('checkout_session.finished', paid);
        tampered.body = tampered.body.replace('15000', '99999');
        await expect(adapter.handleNotification(tampered)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('sin webhookSecret no se puede verificar', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'fintoc', env: { secretKey: 'sk_test_x' } }).handleNotification(event('checkout_session.finished', paid)),
        ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    });
});
