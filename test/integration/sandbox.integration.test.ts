import { describe, expect, it } from 'vitest';
import { createPaymentAdapter } from '../../src';

/**
 * Crea un pago real en cada sandbox y consulta su estado inicial.
 * Corre con `pnpm test:integration`; cada bloque se salta si faltan credenciales.
 */
/** Variable de entorno que el bloque ya comprobó con `skipIf`. */
const env = (name: string): string => process.env[name] ?? '';
const returnUrl = 'https://shop.example/pago/retorno';

describe.skipIf(!process.env.TRANSBANK_COMMERCE_CODE || !process.env.TRANSBANK_API_KEY)('Transbank integración', () => {
    it('crea y consulta una transacción en INITIALIZED', async () => {
        const payments = createPaymentAdapter({
            provider: 'transbank',
            env: { commerceCode: env("TRANSBANK_COMMERCE_CODE"), apiKey: env("TRANSBANK_API_KEY") },
        });
        const created = await payments.create({ amount: 1000, returnUrl });
        expect(created.redirectUrl).toContain('token_ws=');
        const status = await payments.getStatus(created.ref);
        expect(status.status).toBe('PENDING');
        expect(status.providerStatus).toBe('INITIALIZED');
    }, 20_000);
});

describe.skipIf(!process.env.FLOW_API_KEY)('Flow integración', () => {
    it('crea un pago y lo consulta pendiente', async () => {
        const payments = createPaymentAdapter({
            provider: 'flow',
            env: {
                apiKey: env("FLOW_API_KEY"),
                secretKey: env("FLOW_SECRET_KEY"),
                notificationUrl: 'https://shop.example/webhooks/flow',
            },
        });
        const created = await payments.create({ amount: 1000, returnUrl, customer: { email: 'juanperez123@gmail.com' } });
        expect(created.redirectUrl).toContain('token=');
        const status = await payments.getStatus(created.ref);
        expect(status.status).toBe('PENDING');
    }, 20_000);
});

describe.skipIf(!process.env.MERCADOPAGO_ACCESS_TOKEN)('Mercado Pago integración', () => {
    it('crea una preferencia y no encuentra pagos aún', async () => {
        const payments = createPaymentAdapter({ provider: 'mercadopago', env: { accessToken: env("MERCADOPAGO_ACCESS_TOKEN") } });
        const created = await payments.create({ amount: 1000, returnUrl });
        expect(created.redirectUrl).toContain('mercadopago');
        const status = await payments.getStatus(created.ref);
        expect(status.status).toBe('PENDING');
    }, 20_000);
});

describe.skipIf(!(process.env.VENTI_API_KEY ?? process.env.VENTYPAY_API_KEY))('Venti integración', () => {
    it('crea un checkout unpaid', async () => {
        const payments = createPaymentAdapter({ provider: 'venti', env: { apiKey: (process.env.VENTI_API_KEY ?? process.env.VENTYPAY_API_KEY ?? '') } });
        const created = await payments.create({ amount: 1000, returnUrl });
        expect(created.redirectUrl).toContain(created.ref.transactionId);
        const status = await payments.getStatus(created.ref);
        expect(status.status).toBe('PENDING');
    }, 20_000);
});

describe.skipIf(!process.env.KLAP_API_KEY)('Klap integración', () => {
    it('crea una orden pendiente', async () => {
        const payments = createPaymentAdapter({
            provider: 'klap',
            env: { apiKey: env("KLAP_API_KEY"), notificationUrl: 'https://shop.example/webhooks/klap' },
        });
        const created = await payments.create({ amount: 1500, returnUrl, customer: { email: 'juanperez123@gmail.com', name: 'Juan Perez' } });
        expect(created.redirectUrl).toMatch(/^https:/);
        const status = await payments.getStatus(created.ref);
        expect(status).toMatchObject({ status: 'PENDING', amount: 1500 });
    }, 20_000);
});

describe.skipIf(!process.env.GETNET_LOGIN || !process.env.GETNET_SECRET_KEY)('Getnet integración', () => {
    it('crea una sesión pendiente', async () => {
        const payments = createPaymentAdapter({
            provider: 'getnet',
            env: { login: env("GETNET_LOGIN"), secretKey: env("GETNET_SECRET_KEY") },
        });
        const created = await payments.create({
            amount: 1000,
            returnUrl,
            client: { ip: '190.251.4.78', userAgent: 'Mozilla/5.0' },
            customer: { email: 'juanperez123@gmail.com', name: 'Juan Perez' },
        });
        expect(created.redirectUrl).toMatch(/^https:/);
        const status = await payments.getStatus(created.ref);
        expect(status.status).toBe('PENDING');
    }, 20_000);
});

describe.skipIf(!process.env.KHIPU_API_KEY)('Khipu integración', () => {
    it('crea un cobro pendiente y lo cancela', async () => {
        const payments = createPaymentAdapter({ provider: 'khipu', env: { apiKey: env("KHIPU_API_KEY") } });
        const created = await payments.create({ amount: 1000, returnUrl, description: 'Prueba pago-cl' });
        expect(created.redirectUrl).toMatch(/^https:/);
        const status = await payments.getStatus(created.ref);
        expect(status).toMatchObject({ status: 'PENDING', amount: 1000, currency: 'CLP' });
        const canceled = await payments.cancel(created.ref);
        expect(canceled.status).toBe('CANCELED');
        // Khipu sigue devolviendo el cobro borrado: no debe volver a verse pendiente.
        expect((await payments.getStatus(created.ref)).status).toBe('CANCELED');
    }, 30_000);
});

describe.skipIf(!process.env.FINTOC_SECRET_KEY)('Fintoc integración', () => {
    it('crea una sesión pendiente y la cancela', async () => {
        const payments = createPaymentAdapter({ provider: 'fintoc', env: { secretKey: env("FINTOC_SECRET_KEY") } });
        const created = await payments.create({ amount: 1000, returnUrl, customer: { email: 'juanperez123@gmail.com' } });
        expect(created.redirectUrl).toMatch(/^https:/);
        const status = await payments.getStatus(created.ref);
        expect(status).toMatchObject({ status: 'PENDING', amount: 1000, currency: 'CLP' });
        const canceled = await payments.cancel(created.ref);
        expect(canceled.status).toBe('CANCELED');
    }, 30_000);
});
