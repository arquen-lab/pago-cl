import { describe, expect, it } from 'vitest';
import { createPaymentAdapter, type PaymentRef } from '../../src';
import { hmacSha256Base64 } from '../../src/core/webhooks';
import { KHIPU_API } from '../../src/providers/khipu/api';
import { describeCheckoutContract } from '../contract/checkout-contract';
import { getRequest, mockFetch } from '../helpers/fetch';

const env = { apiKey: 'khipu-key', webhookSecret: '1a4cbbbeb8bdb7e1d73572b9cc43ce4ce18f79d9' };
const paymentId = 'zfxnocsow6mz';
const ref: PaymentRef = { provider: 'khipu', orderId: 'ORD-KHIPU-1', transactionId: paymentId, data: { amount: 15000, currency: 'CLP' } };
const returnUrl = 'https://shop.example/pago/ORD-KHIPU-1';
const past = '2020-01-01T00:00:00.000Z';
const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

function payment(status: string, detail: string, extra: Record<string, unknown> = {}) {
    return {
        payment_id: paymentId,
        transaction_id: 'ORD-KHIPU-1',
        status,
        status_detail: detail,
        amount: '15000.0000',
        currency: 'CLP',
        bank: status === 'done' ? 'DemoBank' : undefined,
        payment_method: status === 'done' ? 'simplified_transfer' : 'not_available',
        funds_source: status === 'done' ? '' : 'not-available',
        authorizer_operation_code: status === 'done' ? 'AUT-20260930-0001' : undefined,
        expires_date: future,
        ...extra,
    };
}
const done = payment('done', 'normal');

describeCheckoutContract('khipu', {
    adapter: () => createPaymentAdapter({ provider: 'khipu', env }),
    createInput: { orderId: 'ORD-KHIPU-1', amount: 15000, returnUrl },
    createResponse: {
        body: {
            payment_id: paymentId,
            payment_url: `https://khipu.com/payment/info/${paymentId}`,
            simplified_transfer_url: `https://khipu.com/payment/simplified/${paymentId}`,
            transfer_url: `https://khipu.com/payment/manual/${paymentId}`,
            app_url: `khipu:///pos/${paymentId}`,
            ready_for_terminal: false,
        },
    },
    createdTransactionId: paymentId,
    ref,
    paidResponse: { body: done },
    statuses: [
        { name: 'pending vigente', responses: [{ body: payment('pending', 'pending') }], expect: { status: 'PENDING', amount: 15000 } },
        { name: 'pending vencido por expires_date', responses: [{ body: payment('pending', 'pending', { expires_date: past }) }], expect: { status: 'EXPIRED' } },
        { name: 'verifying', responses: [{ body: payment('verifying', 'pending') }], expect: { status: 'PENDING' } },
        // Observado en el sandbox: tras DELETE el cobro sigue consultable, con status `deleted`.
        { name: 'deleted (cobro borrado)', responses: [{ body: payment('deleted', 'pending') }], expect: { status: 'CANCELED' } },
        { name: 'done normal', responses: [{ body: done }], expect: { status: 'PAID', amount: 15000 } },
        { name: 'done marcado como pagado por el cobrador', responses: [{ body: payment('done', 'marked-paid-by-receiver') }], expect: { status: 'PAID' } },
        { name: 'done rechazado por el pagador', responses: [{ body: payment('done', 'rejected-by-payer') }], expect: { status: 'REJECTED' } },
        { name: 'done marcado como abuso', responses: [{ body: payment('done', 'marked-as-abuse') }], expect: { status: 'REJECTED' } },
        { name: 'done anulado (reversed)', responses: [{ body: payment('done', 'reversed') }], expect: { status: 'PAID', refundedAmount: 15000 } },
        { name: 'done con devolución parcial', responses: [{ body: payment('done', 'partially-refunded', { total_refunded: '5000.0000' }) }], expect: { status: 'PAID', refundedAmount: 5000 } },
        { name: 'done con devolución total', responses: [{ body: payment('done', 'fully-refunded', { total_refunded: '15000.0000' }) }], expect: { status: 'PAID', refundedAmount: 15000 } },
    ],
    returns: [
        { name: 'return_url con el pago conciliado', request: getRequest(returnUrl), responses: [{ body: done }], expect: 'PAID' },
        { name: 'return_url mientras se verifica: queda pendiente', request: getRequest(returnUrl), responses: [{ body: payment('verifying', 'pending') }], expect: 'PENDING' },
        { name: 'cancel_url: el cobro sigue pendiente', request: getRequest(returnUrl), responses: [{ body: payment('pending', 'pending') }], expect: 'PENDING' },
        { name: 'el cobro consultado es de otra orden', request: getRequest(returnUrl), responses: [{ body: payment('done', 'normal', { transaction_id: 'OTRA' }) }], expect: 'RETURN_MISMATCH' },
    ],
});

describe('Khipu Pagos Instantáneos', () => {
    it('crea el cobro con x-api-key, transaction_id, URLs, expiración y notificación v3', async () => {
        const calls = mockFetch([{ body: { payment_id: paymentId, payment_url: 'https://khipu.com/payment/info/x' } }]);
        const expiresAt = new Date(Date.now() + 3600_000);
        await createPaymentAdapter({ provider: 'khipu', env }).create({
            orderId: 'ORD-KHIPU-1',
            amount: 15000,
            description: 'Cobro',
            returnUrl,
            cancelUrl: 'https://shop.example/cancel',
            notificationUrl: 'https://shop.example/webhooks/khipu',
            customer: { email: 'a@b.cl', name: 'Ana Pérez', taxId: '11111111-1' },
            expiresAt,
            metadata: { carro: 'c1' },
            extras: { bankId: 'Bawdf', sendReminders: false },
        });
        expect(calls[0].url).toBe(`${KHIPU_API.baseUrl}/v3/payments`);
        expect(calls[0].headers['x-api-key']).toBe('khipu-key');
        expect(calls[0].json()).toEqual({
            amount: 15000,
            currency: 'CLP',
            subject: 'Cobro',
            transaction_id: 'ORD-KHIPU-1',
            return_url: returnUrl,
            cancel_url: 'https://shop.example/cancel',
            notify_url: 'https://shop.example/webhooks/khipu',
            notify_api_version: '3.0',
            expires_date: expiresAt.toISOString(),
            payer_name: 'Ana Pérez',
            payer_email: 'a@b.cl',
            custom: '{"carro":"c1"}',
            send_reminders: false,
            bank_id: 'Bawdf',
        });
    });

    it('no restringe el pagador por defecto: el RUT del cliente no va como fixed_payer', async () => {
        const calls = mockFetch([{ body: { payment_id: paymentId, payment_url: 'https://khipu.com/payment/info/x' } }]);
        await createPaymentAdapter({ provider: 'khipu', env }).create({ orderId: 'ORD-KHIPU-1', amount: 15000, returnUrl, customer: { taxId: '11111111-1' } });
        expect(calls[0].json()).not.toHaveProperty('fixed_payer_personal_identifier');
    });

    it('UF se envía como CLF y la cancelación cae en la URL de retorno', async () => {
        const calls = mockFetch([{ body: { payment_id: paymentId, payment_url: 'https://khipu.com/payment/info/x' } }]);
        await createPaymentAdapter({ provider: 'khipu', env }).create({ orderId: 'ORD-KHIPU-1', amount: 2.5, currency: 'UF', returnUrl });
        expect(calls[0].json()).toMatchObject({ amount: 2.5, currency: 'CLF', cancel_url: returnUrl });
    });

    it('send_email exige nombre y correo del cliente', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'khipu', env }).create({ orderId: 'ORD-KHIPU-1', amount: 15000, returnUrl, extras: { sendEmail: true } }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'customer' });
    });

    it('un cobro conciliado informa autorización, banco y medio', async () => {
        mockFetch([{ body: done }]);
        const result = await createPaymentAdapter({ provider: 'khipu', env }).getStatus(ref);
        expect(result).toMatchObject({ authorizationCode: 'AUT-20260930-0001', paymentMethod: 'simplified_transfer DemoBank', providerStatus: 'done:normal' });
    });

    it('cancela un cobro pendiente con DELETE y no se puede cancelar uno pagado', async () => {
        const calls = mockFetch([{ body: payment('pending', 'pending') }, { body: { message: 'Pago eliminado' } }, { body: done }]);
        const adapter = createPaymentAdapter({ provider: 'khipu', env });
        const canceled = await adapter.cancel(ref);
        expect(calls[1].method).toBe('DELETE');
        expect(calls[1].url).toBe(`${KHIPU_API.baseUrl}/v3/payments/${paymentId}`);
        expect(canceled).toMatchObject({ status: 'CANCELED', final: true, statusDetail: 'Pago eliminado' });
        await expect(adapter.cancel(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('devolución total sin monto y parcial con monto; nacen PENDING', async () => {
        const calls = mockFetch([
            { body: { id: 'b31bd9aa', payment_id: paymentId, refunded_amount: '15000.0000', total_refunded: '15000.0000', remaining: '0.0000', currency: 'CLP', message: 'Saldo de la billetera insuficiente' } },
            { body: { id: 'c42ce0bb', payment_id: paymentId, refunded_amount: '5000.0000', total_refunded: '5000.0000', remaining: '10000.0000', currency: 'CLP' } },
        ]);
        const adapter = createPaymentAdapter({ provider: 'khipu', env });
        const total = await adapter.refund(ref, { refundId: 'rf-1' });
        expect(calls[0].url).toBe(`${KHIPU_API.baseUrl}/v3/refunds`);
        expect(calls[0].json()).toEqual({ type: 'full', payment_id: paymentId });
        expect(total).toMatchObject({ status: 'PENDING', amount: 15000, refundableAmount: 0, statusDetail: 'Saldo de la billetera insuficiente', refund: { providerRefundId: 'b31bd9aa', refundId: 'rf-1' } });
        const partial = await adapter.refund(ref, { refundId: 'rf-2', amount: 5000 });
        expect(calls[1].json()).toEqual({ type: 'partial', payment_id: paymentId, amount: '5000' });
        expect(partial).toMatchObject({ status: 'PENDING', amount: 5000, refundableAmount: 10000 });
    });

    it('getRefund lee el estado de la devolución dentro del pago', async () => {
        const refunds = [
            { id: 'b31bd9aa', status: 'pending', amount: '15000.0000', currency: 'CLP' },
            { id: 'c42ce0bb', status: 'paid', amount: '5000.0000', currency: 'CLP' },
            { id: 'd53df1cc', status: 'expired', amount: '1000.0000', currency: 'CLP' },
        ];
        mockFetch([{ body: payment('done', 'partially-refunded', { refunds }) }, { body: payment('done', 'partially-refunded', { refunds }) }, { body: payment('done', 'partially-refunded', { refunds }) }, { body: done }]);
        const adapter = createPaymentAdapter({ provider: 'khipu', env });
        const base = { provider: 'khipu', payment: ref };
        expect(await adapter.getRefund({ ...base, refundId: 'a', providerRefundId: 'b31bd9aa' })).toMatchObject({ status: 'PENDING', amount: 15000 });
        expect(await adapter.getRefund({ ...base, refundId: 'b', providerRefundId: 'c42ce0bb' })).toMatchObject({ status: 'SUCCEEDED', amount: 5000 });
        expect(await adapter.getRefund({ ...base, refundId: 'c', providerRefundId: 'd53df1cc' })).toMatchObject({ status: 'FAILED' });
        await expect(adapter.getRefund({ ...base, refundId: 'd', providerRefundId: 'inexistente' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('un error con message llega al mensaje y no es reintentable', async () => {
        mockFetch([{ status: 400, body: { message: 'amount: debe ser mayor a cero' } }]);
        await expect(createPaymentAdapter({ provider: 'khipu', env }).getStatus(ref)).rejects.toMatchObject({
            code: 'PROVIDER_ERROR',
            message: 'Khipu: amount: debe ser mayor a cero',
            provider: { httpStatus: 400, retryable: false },
        });
    });

    // Ejemplo de la documentación de Khipu: secreto, cabecera y cuerpo con resultado conocido.
    const docBody = String.raw`{"payment_id":"zfxnocsow6mz","receiver_id":990939,"subject":"TEST_COBRO","amount":"1000.0000","discount":"0.0000","currency":"CLP","receipt_url":"https:\/\/s3.amazonaws.com\/staging.notifications.khipu.com\/CPKH-1804240956-zfxnocsow6mz.pdf","bank":"DemoBank","bank_id":"Bawdf","payer_name":"Cobrador de desarrollo #990.939","payer_email":"test@khipu.com","personal_identifier":"44.444.444-4","bank_account_number":"000000000000444444444","out_of_date_conciliation":false,"transaction_id":"15f836bd-e8a7-4d12-b2f1-56403012b555","authorizer_operation_code":"AUT-20240418-0001","responsible_user_email":"test@khipu.com","payment_method":"simplified_transfer","conciliation_date":"2024-04-18T13:56:54.859Z"}`;
    const docSignature = 't=1711965600393,s=rq08YUGSaWa1D0RAwhMnJTRHMNmY4ToCn2Gd6G9LaDg=';
    const noExpiry = { ...env, signatureToleranceSeconds: 1e10 };

    function webhook(body: string, signature: string) {
        return { method: 'POST', url: 'https://shop.example/webhooks/khipu', headers: { 'content-type': 'application/json', 'x-khipu-signature': signature }, body };
    }

    it('verifica la firma del ejemplo oficial de la documentación (resultado conocido)', async () => {
        const calls = mockFetch([]);
        const notification = await createPaymentAdapter({ provider: 'khipu', env: noExpiry }).handleNotification(webhook(docBody, docSignature));
        expect(calls).toHaveLength(0);
        expect(notification.reply.status).toBe(200);
        expect(notification.eventId).toBe('zfxnocsow6mz:2024-04-18T13:56:54.859Z');
        expect(notification.result).toMatchObject({
            status: 'PAID',
            final: true,
            amount: 1000,
            currency: 'CLP',
            authorizationCode: 'AUT-20240418-0001',
            paymentMethod: 'simplified_transfer DemoBank',
            ref: { transactionId: 'zfxnocsow6mz', orderId: '15f836bd-e8a7-4d12-b2f1-56403012b555' },
        });
    });

    it('rechaza el cuerpo del ejemplo si cambia un solo carácter', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'khipu', env: noExpiry }).handleNotification(webhook(docBody.replace('1000.0000', '9000.0000'), docSignature)),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('rechaza una firma con otro secreto y una firma vencida', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'khipu', env: { ...noExpiry, webhookSecret: 'otro' } }).handleNotification(webhook(docBody, docSignature)),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
        await expect(createPaymentAdapter({ provider: 'khipu', env }).handleNotification(webhook(docBody, docSignature))).rejects.toMatchObject({
            code: 'VERIFICATION_FAILED',
            message: expect.stringContaining('expiró'),
        });
    });

    it('rechaza una notificación sin cabecera de firma', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'khipu', env }).handleNotification({ method: 'POST', url: '/', headers: {}, body: docBody }),
        ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    });

    it('sin webhookSecret no se puede verificar', async () => {
        mockFetch([]);
        await expect(
            createPaymentAdapter({ provider: 'khipu', env: { apiKey: 'k' } }).handleNotification(webhook(docBody, docSignature)),
        ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    });

    it('firma recién generada con la hora actual es aceptada; cuerpo no JSON responde 400', async () => {
        const adapter = createPaymentAdapter({ provider: 'khipu', env });
        const t = String(Date.now());
        const good = JSON.stringify({ payment_id: paymentId, transaction_id: 'ORD-KHIPU-1', amount: 15000, currency: 'CLP' });
        const ok = await adapter.handleNotification(webhook(good, `t=${t},s=${hmacSha256Base64(env.webhookSecret, `${t}.${good}`)}`));
        expect(ok.result).toMatchObject({ status: 'PAID', amount: 15000, ref: { orderId: 'ORD-KHIPU-1' } });
        const bad = 'esto no es json';
        const rejected = await adapter.handleNotification(webhook(bad, `t=${t},s=${hmacSha256Base64(env.webhookSecret, `${t}.${bad}`)}`));
        expect(rejected.reply.status).toBe(400);
        expect(rejected.result).toBeUndefined();
    });
});
