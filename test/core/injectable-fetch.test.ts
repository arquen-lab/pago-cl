import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaymentAdapter, isPaymentError, type FetchLike, type PaymentRef } from '../../src';
import { generateOrderId } from '../../src';
import { TRANSBANK_API } from '../../src/providers/transbank/api';

const MARKER = '{{secret.apiSecret}}';
const token = `01ab${'f'.repeat(60)}`;
const returnUrl = 'https://shop.example/pago/ORD-1';
const authorized = { buy_order: 'ORD-1', session_id: 's', status: 'AUTHORIZED', response_code: 0, amount: 15000, authorization_code: '1213' };
const ref: PaymentRef = { provider: 'transbank', orderId: 'ORD-1', transactionId: token, data: { amount: 15000, currency: 'CLP' } };
const deferredRef: PaymentRef = { ...ref, data: { ...ref.data, deferred: true } };

interface Seen {
    url: string;
    method: string;
    headers: Record<string, string>;
}

/** Un `fetch` falso que responde en orden y anota lo que recibe. */
function fakeFetch(bodies: unknown[]): { fetch: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    const queue = [...bodies];
    const fetch: FetchLike = async (input, init) => {
        seen.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
        const text = JSON.stringify(queue.shift() ?? {});
        return { ok: true, status: 200, statusText: 'OK', text: async () => text } as Response;
    };
    return { fetch, seen };
}

function guardGlobal() {
    const spy = vi.fn(async () => {
        throw new Error('se usó el fetch global');
    });
    vi.stubGlobal('fetch', spy);
    return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetch inyectable', () => {
    it('usa solo el fetch inyectado y nunca el global', async () => {
        const globalSpy = guardGlobal();
        const { fetch, seen } = fakeFetch([{ token, url: 'https://webpay3gint.transbank.cl/x' }, authorized, authorized]);
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey: 'k', fetch } });
        await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl });
        await adapter.getStatus(ref);
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(globalSpy).not.toHaveBeenCalled();
    });

    it('pone el apiKey tal cual en el encabezado, incluido un marcador con llaves', async () => {
        for (const apiKey of [MARKER, '  con espacios  ', 'k']) {
            const { fetch, seen } = fakeFetch([{ token, url: 'https://x' }]);
            await createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey, fetch } }).create({
                orderId: 'ORD-1',
                amount: 15000,
                returnUrl,
            });
            expect(seen[0].headers[TRANSBANK_API.headers.apiKeySecret]).toBe(apiKey);
        }
    });

    it('create, handleReturn, getStatus, capture, cancel y refund funcionan con el fetch inyectado', async () => {
        const { fetch } = fakeFetch([
            { token, url: 'https://x' }, // create
            authorized, // handleReturn (commit)
            authorized, // getStatus
            authorized, // capture: consulta
            { token, authorization_code: '1213', captured_amount: 12000, response_code: 0 }, // capture
            authorized, // refund: consulta
            { type: 'REVERSED' }, // refund
        ]);
        const env = { commerceCode: 'cc', apiKey: MARKER, deferredCommerceCode: 'dc', deferredApiKey: 'dk', fetch };
        const adapter = createPaymentAdapter({ provider: 'transbank', env });
        const created = await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl });
        expect(created.ref.transactionId).toBe(token);
        const returned = await adapter.handleReturn(ref, { method: 'GET', url: `${returnUrl}?token_ws=${token}`, headers: {} });
        expect(returned.status).toBe('PAID');
        expect((await adapter.getStatus(ref)).status).toBe('PAID');
        expect((await adapter.capture(deferredRef, 12000)).status).toBe('PAID');
        expect((await adapter.refund(ref, { refundId: 'rf1' })).status).toBe('SUCCEEDED');
        // Webpay Plus no anula pagos sin cobrar: igual que antes, sin tocar ningún fetch
        await expect(adapter.cancel(ref)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    });

    it('cancel funciona con el fetch inyectado en otra pasarela y no toca el global', async () => {
        const globalSpy = guardGlobal();
        const payment = (status: string) => ({ id: 987654321, external_reference: 'ORD-MP-1', status, transaction_amount: 15000, transaction_amount_refunded: 0, currency_id: 'CLP' });
        const { fetch, seen } = fakeFetch([{ results: [payment('pending')], paging: { total: 1 } }, payment('cancelled')]);
        const mpRef: PaymentRef = { provider: 'mercadopago', orderId: 'ORD-MP-1', transactionId: 'pref-1', data: { amount: 15000, currency: 'CLP' } };
        const result = await createPaymentAdapter({ provider: 'mercadopago', env: { accessToken: MARKER, webhookSecret: 'w', fetch } }).cancel(mpRef);
        expect(result.status).toBe('CANCELED');
        expect(seen[1].method).toBe('PUT');
        expect(seen[1].headers.Authorization).toBe(`Bearer ${MARKER}`);
        expect(globalSpy).not.toHaveBeenCalled();
    });

    it('sin fetch inyectado usa el global, resuelto en cada llamada', async () => {
        const first = fakeFetch([{ token, url: 'https://x' }]);
        const second = fakeFetch([{ token, url: 'https://x' }]);
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey: 'k' } });
        vi.stubGlobal('fetch', first.fetch);
        await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl });
        vi.stubGlobal('fetch', second.fetch);
        await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl });
        expect(first.seen).toHaveLength(1);
        expect(second.seen).toHaveLength(1);
    });

    it('un error del transporte sale como error del SDK y sin la llave', async () => {
        const fetch: FetchLike = async () => {
            throw new TypeError('fetch failed');
        };
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey: MARKER, fetch } });
        const error = await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl }).catch((e: unknown) => e);
        expect(isPaymentError(error)).toBe(true);
        expect(error).toMatchObject({ code: 'PROVIDER_ERROR', provider: { retryable: true } });
        expect(JSON.stringify(error)).not.toContain(MARKER);
        expect((error as Error).message).not.toContain(MARKER);
        expect(String((error as Error).stack)).not.toContain(MARKER);
    });

    it('las respuestas HTTP de error tampoco llevan la llave', async () => {
        const fetch: FetchLike = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error_message":"No autorizado"}' }) as Response;
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey: MARKER, fetch } });
        const error = await adapter.getStatus(ref).catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'PROVIDER_ERROR', provider: { httpStatus: 401 } });
        expect(JSON.stringify(error)).not.toContain(MARKER);
    });

    it('la referencia y los datos de un pago no contienen la llave', async () => {
        const { fetch } = fakeFetch([{ token, url: 'https://x' }]);
        const adapter = createPaymentAdapter({ provider: 'transbank', env: { commerceCode: 'cc', apiKey: MARKER, fetch }, rawRequest: true });
        const created = await adapter.create({ orderId: 'ORD-1', amount: 15000, returnUrl });
        expect(JSON.stringify(created)).not.toContain(MARKER);
    });
});

describe('sin módulos de Node', () => {
    it('generateOrderId usa Web Crypto y cumple el formato', () => {
        expect(generateOrderId()).toMatch(/^[A-Za-z0-9_-]{1,26}$/);
    });
});
