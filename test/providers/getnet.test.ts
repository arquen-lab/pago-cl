import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { sha256Hex } from '../../src/core/webhooks';
import { GETNET_API } from '../../src/providers/getnet/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch, postJson } from '../helpers/fetch';

const env = { login: 'getnet-login', secretKey: 'getnet-secret' };
const ref: PaymentRef = { provider: 'getnet', orderId: 'ORD-GN-1', transactionId: '306502', data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-GN-1';
const client = { ip: '190.251.4.78', userAgent: 'Mozilla/5.0' };

function session(status: string, extra: Record<string, unknown> = {}, reason = status === 'PENDING' ? 'PC' : '00') {
    return {
        requestId: 306502,
        status: { status, reason, message: 'x', date: '2026-09-30T19:22:12+00:00' },
        request: { locale: 'es_CL', payment: { reference: 'ORD-GN-1', description: 'Orden', amount: { currency: 'CLP', total: 15000 } }, returnUrl },
        payment: null,
        ...extra,
    };
}
const approvedPayment = {
    status: { status: 'APPROVED', reason: '00', message: 'Aprobada', date: '2026-09-30T19:25:00+00:00' },
    internalReference: 94236,
    reference: 'ORD-GN-1',
    paymentMethod: 'master',
    paymentMethodName: 'Master',
    amount: { from: { currency: 'CLP', total: 15000 }, to: { currency: 'CLP', total: 15000 } },
    receipt: '303312009300',
    refunded: false,
    authorization: '600236',
    processorFields: [{ keyword: 'cardType', value: 'C' }, { keyword: 'lastDigits', value: '4753' }],
};
const approved = session('APPROVED', { payment: [approvedPayment] });

describeCheckoutContract('getnet', {
    adapter: () => createPaymentAdapter({ provider: 'getnet', env }),
    createInput: { orderId: 'ORD-GN-1', amount: 15000, returnUrl, client },
    createResponse: { body: { status: { status: 'OK', reason: 'PC', message: 'ok', date: 'd' }, requestId: 306502, processUrl: 'https://checkout.test.getnet.cl/spa/session/306502/abc' } },
    createdTransactionId: '306502',
    ref,
    paidResponse: { body: approved },
    statuses: [
        { name: 'PENDING', responses: [{ body: session('PENDING') }], expect: { status: 'PENDING', amount: 15000 } },
        { name: 'APPROVED', responses: [{ body: approved }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'REJECTED', responses: [{ body: session('REJECTED', { payment: [{ ...approvedPayment, status: { status: 'REJECTED', reason: '51' }, authorization: undefined }] }, '?C') }], expect: { status: 'REJECTED' } },
        { name: 'REJECTED por expiración (EX)', responses: [{ body: session('REJECTED', {}, 'EX') }], expect: { status: 'EXPIRED' } },
        { name: 'APPROVED con reverso', responses: [{ body: session('APPROVED', { payment: [{ ...approvedPayment, refunded: true }] }) }], expect: { status: 'PAID', refundedAmount: 15000 } },
    ],
    returns: [
        { name: 'el retorno no trae datos: consulta la sesión', request: getRequest(returnUrl), responses: [{ body: approved }], expect: 'PAID' },
        { name: 'vuelve por cancelUrl: sigue pendiente', request: getRequest(returnUrl), responses: [{ body: session('PENDING') }], expect: 'PENDING' },
        { name: 'la sesión es de otra referencia', request: getRequest(returnUrl), responses: [{ body: session('APPROVED', { request: { payment: { reference: 'OTRA', amount: { currency: 'CLP', total: 1 } } } }) }], expect: 'RETURN_MISMATCH' },
    ],
});

describe('Getnet Web Checkout', () => {
    it('exige ip y user agent del pagador', async () => {
        mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'getnet', env }).create({ orderId: 'ORD-GN-1', amount: 1000, returnUrl })).rejects.toMatchObject({
            code: 'MISSING_FIELD',
            field: 'client.ip',
        });
    });

    it('crea la sesión con auth firmado, buyer, expiración y fields', async () => {
        const calls = mockFetch([{ body: { status: { status: 'OK' }, requestId: 1, processUrl: 'https://checkout.test.getnet.cl/spa/session/1/x' } }]);
        const expiresAt = new Date(Date.now() + 20 * 60_000);
        await createPaymentAdapter({ provider: 'getnet', env }).create({
            orderId: 'ORD-GN-1',
            amount: 15000,
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            client,
            customer: { email: 'test@test.com', name: 'Ana Pérez', taxId: '11111111-9' },
            metadata: { carro: 'c1' },
            expiresAt,
            extras: { skipResult: true },
        });
        const body = calls[0].json() as Record<string, any>;
        expect(calls[0].url).toBe(`${GETNET_API.hosts.sandbox}/api/session/`);
        expect(body.auth).toMatchObject({ login: env.login, tranKey: expect.any(String), nonce: expect.any(String), seed: expect.any(String) });
        expect(body).toMatchObject({
            locale: 'es_CL',
            buyer: { email: 'test@test.com', name: 'Ana', surname: 'Pérez', document: '11111111-9', documentType: 'CLRUT' },
            payment: { reference: 'ORD-GN-1', amount: { currency: 'CLP', total: 15000 } },
            expiration: expiresAt.toISOString(),
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            ipAddress: client.ip,
            userAgent: client.userAgent,
            skipResult: true,
            fields: [{ keyword: 'carro', value: 'c1', displayOn: 'none' }],
        });
    });

    it('rechaza una expiración menor a 5 minutos', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'getnet', env }).create({ orderId: 'ORD-GN-1', amount: 1000, returnUrl, client, expiresAt: new Date(Date.now() + 60_000) }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'expiresAt' });
    });

    it('un 200 con status FAILED es PROVIDER_ERROR', async () => {
        mockFetch([{ body: { status: { status: 'FAILED', reason: '102', message: 'El hash de TranKey no coincide' } } }]);
        await expect(createPaymentAdapter({ provider: 'getnet', env }).getStatus(ref)).rejects.toMatchObject({
            code: 'PROVIDER_ERROR',
            provider: { providerCode: '102' },
        });
    });

    it('la consulta guarda internalReference y devuelve medio y autorización', async () => {
        mockFetch([{ body: approved }]);
        const result = await createPaymentAdapter({ provider: 'getnet', env }).getStatus(ref);
        expect(result).toMatchObject({ status: 'PAID', authorizationCode: '600236', paymentMethod: 'Master C', ref: { data: { internalReference: 94236 } } });
    });

    it('reversa el total con internalReference', async () => {
        const calls = mockFetch([{ body: approved }, { body: { status: { status: 'APPROVED', reason: '00', message: 'Se ha reversado' }, payment: { ...approvedPayment, amount: { from: { currency: 'CLP', total: -15000 }, to: { currency: 'CLP', total: -15000 } } } } }]);
        const refund = await createPaymentAdapter({ provider: 'getnet', env }).refund(ref, { refundId: 'rf-gn' });
        expect(calls[1].url).toBe(`${GETNET_API.hosts.sandbox}/api/reverse`);
        expect(calls[1].json()).toMatchObject({ internalReference: '94236' });
        expect(refund).toMatchObject({ status: 'SUCCEEDED', amount: 15000 });
    });

    it('no reembolsa parcial', async () => {
        mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'getnet', env }).refund(ref, { amount: 100 })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });

    function notification(status: string, date: string, secret: string = env.secretKey) {
        const signature = sha256Hex(`306502${status}${date}${secret}`);
        return postJson('https://shop.example/webhooks/getnet', { status: { status, reason: '00', message: 'x', date }, requestId: 306502, reference: 'ORD-GN-1', signature: `sha256:${signature}` });
    }

    it('verifica la firma de la notificación y reconsulta', async () => {
        const calls = mockFetch([{ body: approved }]);
        const result = await createPaymentAdapter({ provider: 'getnet', env }).handleNotification(notification('APPROVED', '2026-09-30T19:25:00+00:00'));
        expect(calls[0].url).toBe(`${GETNET_API.hosts.sandbox}/api/session/306502`);
        expect(result).toMatchObject({ reply: { status: 200 }, result: { status: 'PAID', ref: { orderId: 'ORD-GN-1', transactionId: '306502' } } });
    });

    it('rechaza una firma con otro secreto', async () => {
        const calls = mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'getnet', env }).handleNotification(notification('APPROVED', 'd', 'otro'))).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
        expect(calls).toHaveLength(0);
    });
});
