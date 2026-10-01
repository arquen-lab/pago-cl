import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { TRANSBANK_API } from '../../src/providers/transbank/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch } from '../helpers/fetch';

const DEFERRED_CODE = 'tbk-deferred-code';
const env = {
    commerceCode: 'tbk-commerce-code',
    apiKey: 'tbk-secret',
    environment: 'sandbox' as const,
};
const token = `01ab${'f'.repeat(60)}`;
const ref: PaymentRef = { provider: 'transbank', orderId: 'ORD-TBK-1', transactionId: token, data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-TBK-1';

const authorized = {
    buy_order: 'ORD-TBK-1',
    session_id: 'sess_ORD-TBK-1',
    status: 'AUTHORIZED',
    response_code: 0,
    amount: 15000,
    authorization_code: '1213',
    payment_type_code: 'VN',
    vci: 'TSY',
};
const initialized = { buy_order: 'ORD-TBK-1', session_id: 'sess_ORD-TBK-1', status: 'INITIALIZED', amount: 15000 };

describeCheckoutContract('transbank', {
    adapter: () => createPaymentAdapter({ provider: 'transbank', env }),
    createInput: { orderId: 'ORD-TBK-1', amount: 15000, returnUrl },
    createResponse: { body: { token, url: 'https://webpay3gint.transbank.cl/webpayserver/initTransaction' } },
    createdTransactionId: token,
    ref,
    paidResponse: { body: authorized },
    statuses: [
        { name: 'INITIALIZED (sin pagar o anulada)', responses: [{ body: initialized }], expect: { status: 'PENDING' } },
        { name: 'AUTHORIZED con response_code 0', responses: [{ body: authorized }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'AUTHORIZED con response_code -1', responses: [{ body: { ...authorized, response_code: -1 } }], expect: { status: 'REJECTED' } },
        { name: 'FAILED', responses: [{ body: { ...initialized, status: 'FAILED', response_code: -1 } }], expect: { status: 'REJECTED' } },
        { name: 'REVERSED', responses: [{ body: { ...authorized, status: 'REVERSED' } }], expect: { status: 'PAID', refundedAmount: 15000 } },
        { name: 'NULLIFIED', responses: [{ body: { ...authorized, status: 'NULLIFIED', balance: 0 } }], expect: { status: 'PAID', refundedAmount: 15000 } },
        { name: 'PARTIALLY_NULLIFIED con balance', responses: [{ body: { ...authorized, status: 'PARTIALLY_NULLIFIED', balance: 10000 } }], expect: { status: 'PAID', refundedAmount: 5000 } },
        { name: 'CAPTURED', responses: [{ body: { ...authorized, status: 'CAPTURED' } }], expect: { status: 'PAID' } },
    ],
    returns: [
        { name: 'token_ws: hace commit y queda PAID', request: getRequest(`${returnUrl}?token_ws=${token}`), responses: [{ body: authorized }], expect: 'PAID' },
        { name: 'token_ws con rechazo', request: getRequest(`${returnUrl}?token_ws=${token}`), responses: [{ body: { ...authorized, response_code: -1 } }], expect: 'REJECTED' },
        { name: 'TBK_TOKEN: el usuario anuló', request: getRequest(`${returnUrl}?TBK_TOKEN=${token}&TBK_ORDEN_COMPRA=ORD-TBK-1&TBK_ID_SESION=s`), responses: [{ body: initialized }], expect: 'CANCELED' },
        { name: 'token_ws y TBK_TOKEN: error y volver al sitio', request: getRequest(`${returnUrl}?token_ws=${token}&TBK_TOKEN=${token}&TBK_ORDEN_COMPRA=ORD-TBK-1`), responses: [{ body: initialized }], expect: 'CANCELED' },
        { name: 'solo TBK_ORDEN_COMPRA: expiró el formulario', request: getRequest(`${returnUrl}?TBK_ORDEN_COMPRA=ORD-TBK-1&TBK_ID_SESION=s`), responses: [{ body: initialized }], expect: 'EXPIRED' },
        { name: 'token de otra transacción', request: getRequest(`${returnUrl}?token_ws=${'9'.repeat(64)}`), expect: 'RETURN_MISMATCH' },
        { name: 'orden de compra de otra orden', request: getRequest(`${returnUrl}?TBK_ORDEN_COMPRA=OTRA&TBK_ID_SESION=s`), expect: 'RETURN_MISMATCH' },
    ],
});

describe('Webpay Plus', () => {
    it('crea la transacción con los cuatro campos y el session_id derivado', async () => {
        const calls = mockFetch([{ body: { token, url: 'https://webpay3gint.transbank.cl/webpayserver/initTransaction' } }]);
        const created = await createPaymentAdapter({ provider: 'transbank', env }).create({
            orderId: 'ORD-TBK-1',
            amount: 15000,
            returnUrl,
            customer: { email: 'ignorado@shop.example' },
        });
        expect(calls[0].url).toBe(`${TRANSBANK_API.hosts.sandbox}/transactions`);
        expect(calls[0].headers['Tbk-Api-Key-Id']).toBe(env.commerceCode);
        expect(calls[0].json()).toEqual({ buy_order: 'ORD-TBK-1', session_id: 'sess_ORD-TBK-1', amount: 15000, return_url: returnUrl });
        expect(created.redirectUrl).toBe(`https://webpay3gint.transbank.cl/webpayserver/initTransaction?token_ws=${token}`);
    });

    it('un segundo commit (422) cae a la consulta de estado', async () => {
        const calls = mockFetch([
            { status: 422, body: { error_message: "Transaction already finished" } },
            { body: authorized },
        ]);
        const result = await createPaymentAdapter({ provider: 'transbank', env }).handleReturn(ref, getRequest(`${returnUrl}?token_ws=${token}`));
        expect(result.status).toBe('PAID');
        expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET']);
    });

    it('el reembolso pide el monto total cuando no se indica y lee la reversa', async () => {
        const calls = mockFetch([{ body: authorized }, { body: { type: 'REVERSED' } }]);
        const refund = await createPaymentAdapter({ provider: 'transbank', env }).refund(ref, { refundId: 'rf1' });
        expect(calls[1].url).toBe(`${TRANSBANK_API.hosts.sandbox}/transactions/${token}/refunds`);
        expect(calls[1].json()).toEqual({ amount: 15000 });
        expect(refund).toMatchObject({ status: 'SUCCEEDED', amount: 15000, refund: { refundId: 'rf1' } });
    });

    it('la anulación parcial informa el saldo restante', async () => {
        mockFetch([{ body: { type: 'NULLIFIED', response_code: 0, nullified_amount: 5000, balance: 10000, authorization_code: '1213' } }]);
        const refund = await createPaymentAdapter({ provider: 'transbank', env }).refund(ref, { amount: 5000 });
        expect(refund).toMatchObject({ status: 'SUCCEEDED', amount: 5000, refundableAmount: 10000 });
    });
});

describe('Webpay Plus Captura Diferida', () => {
    const deferredEnv = { ...env, deferredCommerceCode: DEFERRED_CODE };
    const deferredRef: PaymentRef = { ...ref, data: { ...ref.data, deferred: true } };

    it('sin deferredCommerceCode no hay captura', async () => {
        mockFetch([]);
        const adapter = createPaymentAdapter({ provider: 'transbank', env });
        expect(adapter.capabilities.capture).toBe(false);
        await expect(adapter.create({ orderId: 'ORD-TBK-1', amount: 1000, returnUrl, capture: 'manual' })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
        await expect(adapter.capture(ref)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });

    it('capture manual crea con el código diferido y lo recuerda en la ref', async () => {
        const calls = mockFetch([{ body: { token, url: 'https://webpay3gint.transbank.cl/webpayserver/initTransaction' } }]);
        const created = await createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).create({
            orderId: 'ORD-TBK-1',
            amount: 15000,
            returnUrl,
            capture: 'manual',
        });
        expect(calls[0].headers['Tbk-Api-Key-Id']).toBe(DEFERRED_CODE);
        expect(created.ref.data?.deferred).toBe(true);
    });

    it('el código diferido usa su propia llave; el normal sigue con la suya', async () => {
        const calls = mockFetch([
            { body: { token, url: 'https://webpay3gint.transbank.cl/webpayserver/initTransaction' } },
            { body: { token, url: 'https://webpay3gint.transbank.cl/webpayserver/initTransaction' } },
        ]);
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { ...deferredEnv, deferredApiKey: 'deferred-secret' } });
        await adapter.create({ orderId: 'ORD-TBK-1', amount: 15000, returnUrl, capture: 'manual' });
        await adapter.create({ orderId: 'ORD-TBK-2', amount: 15000, returnUrl });
        expect(calls[0].headers['Tbk-Api-Key-Secret']).toBe('deferred-secret');
        expect(calls[1].headers['Tbk-Api-Key-Secret']).toBe(env.apiKey);
    });

    it('en producción exige deferredApiKey junto con deferredCommerceCode', () => {
        const production = { ...deferredEnv, environment: 'production' as const };
        expect(() => createPaymentAdapter({ provider: 'transbank', env: production })).toThrow(/deferredApiKey/);
        expect(() =>
            createPaymentAdapter({ provider: 'transbank', env: { ...production, deferredApiKey: 'deferred-secret' } }),
        ).not.toThrow();
    });

    it('capture automático usa el código normal aunque el diferido esté configurado', async () => {
        const calls = mockFetch([{ body: { token, url: 'https://webpay3gint.transbank.cl/x' } }]);
        const created = await createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).create({ orderId: 'ORD-TBK-1', amount: 15000, returnUrl });
        expect(calls[0].headers['Tbk-Api-Key-Id']).toBe(env.commerceCode);
        expect(created.ref.data?.deferred).toBe(false);
    });

    it('el commit de un pago diferido deja AUTHORIZED y guarda el código de autorización', async () => {
        const calls = mockFetch([{ body: authorized }]);
        const result = await createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).handleReturn(
            deferredRef,
            getRequest(`${returnUrl}?token_ws=${token}`),
        );
        expect(calls[0].headers['Tbk-Api-Key-Id']).toBe(DEFERRED_CODE);
        expect(result.status).toBe('AUTHORIZED');
        expect(result.final).toBe(false);
        expect(result.ref.data?.authorizationCode).toBe('1213');
    });

    it('captura con el código de autorización y deja PAID', async () => {
        const calls = mockFetch([
            { body: authorized },
            { body: { token, authorization_code: '1213', captured_amount: 12000, response_code: 0 } },
        ]);
        const result = await createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).capture(deferredRef, 12000);
        expect(calls[1].url).toBe(`${TRANSBANK_API.hosts.sandbox}/transactions/${token}/capture`);
        expect(calls[1].json()).toEqual({ buy_order: 'ORD-TBK-1', authorization_code: '1213', capture_amount: 12000 });
        expect(result).toMatchObject({ status: 'PAID', amount: 12000, final: true });
    });

    it('no captura más que lo autorizado', async () => {
        mockFetch([{ body: authorized }]);
        await expect(
            createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).capture(deferredRef, 20000),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'amount' });
    });

    it('un pago creado con captura automática no se puede capturar', async () => {
        mockFetch([]);
        await expect(createPaymentAdapter({ provider: 'transbank', env: deferredEnv }).capture(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});
