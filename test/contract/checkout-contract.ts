import { afterEach, describe, expect, it } from 'vitest';
import {
    isPaymentError,
    type CreateInput,
    type IncomingRequest,
    type PaymentAdapter,
    type PaymentRef,
    type PaymentStatus,
} from '../../src';
import { failingFetch, mockFetch, type FakeResponse } from '../helpers/fetch';

export interface StatusCase {
    name: string;
    /** Respuestas de fetch, en orden, para un getStatus. */
    responses: FakeResponse[];
    expect: { status: PaymentStatus; refundedAmount?: number; amount?: number };
}

export interface ReturnCase {
    name: string;
    request: IncomingRequest;
    responses?: FakeResponse[];
    /** Estado esperado, o el código de error esperado. */
    expect: PaymentStatus | 'RETURN_MISMATCH';
}

export interface ContractFixtures {
    adapter: () => PaymentAdapter<any>;
    /** Si `env` trae una notificationUrl por defecto: el mismo adapter sin ella. */
    adapterWithoutDefaultUrl?: () => PaymentAdapter<any>;
    /** Input válido mínimo para esta pasarela. */
    createInput: CreateInput<any>;
    createResponse: FakeResponse;
    createdTransactionId: string;
    /** Referencia guardada, como la devolvería create. */
    ref: PaymentRef;
    statuses: StatusCase[];
    returns: ReturnCase[];
    /** Respuesta grabada de un pago aprobado, para las pruebas de errores. */
    paidResponse: FakeResponse;
}

/**
 * Lo que todo adapter tiene que cumplir, con respuestas grabadas.
 * Agregar un caso aquí lo exige a todas las pasarelas.
 */
export function describeCheckoutContract(name: string, fixtures: ContractFixtures): void {
    describe(`contrato · ${name}`, () => {
        afterEach(() => {
            // vitest limpia los stubs con unstubGlobals: true en la config
        });

        describe('create', () => {
            it('devuelve ref con orderId y transactionId, y una URL de redirección', async () => {
                mockFetch([fixtures.createResponse]);
                const created = await fixtures.adapter().create(fixtures.createInput);
                expect(created.ref.provider).toBe(fixtures.adapter().provider);
                expect(created.ref.orderId).toBe(fixtures.createInput.orderId);
                expect(created.ref.transactionId).toBe(fixtures.createdTransactionId);
                expect(created.redirectUrl).toMatch(/^https?:\/\//);
            });

            it('genera orderId cuando falta', async () => {
                mockFetch([fixtures.createResponse]);
                const { orderId: _omit, ...input } = fixtures.createInput;
                const created = await fixtures.adapter().create(input);
                expect(created.ref.orderId).toMatch(/^[A-Za-z0-9_-]{1,26}$/);
            });

            it('rechaza decimales en CLP sin salir a la red', async () => {
                const calls = mockFetch([]);
                await expect(fixtures.adapter().create({ ...fixtures.createInput, amount: 1000.5 })).rejects.toMatchObject({
                    code: 'INVALID_INPUT',
                    field: 'amount',
                });
                expect(calls).toHaveLength(0);
            });

            it('rechaza un orderId fuera del mínimo común', async () => {
                const calls = mockFetch([]);
                await expect(
                    fixtures.adapter().create({ ...fixtures.createInput, orderId: 'ORD 1/2' }),
                ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'orderId' });
                expect(calls).toHaveLength(0);
            });

            it('rechaza returnUrl relativa', async () => {
                mockFetch([]);
                await expect(
                    fixtures.adapter().create({ ...fixtures.createInput, returnUrl: '/pago/ORD-1' }),
                ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'returnUrl' });
            });

            it('rechaza una moneda que la pasarela no acepta', async () => {
                mockFetch([]);
                const adapter = fixtures.adapter();
                const unsupported = (['CLP', 'UF', 'USD'] as const).find((c) => !adapter.capabilities.currencies.includes(c));
                if (!unsupported) return;
                await expect(
                    adapter.create({ ...fixtures.createInput, currency: unsupported }),
                ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'currency' });
            });
        });

        describe('getStatus', () => {
            for (const status of fixtures.statuses) {
                it(`${status.name} → ${status.expect.status}`, async () => {
                    mockFetch(status.responses);
                    const result = await fixtures.adapter().getStatus(fixtures.ref);
                    expect(result.status).toBe(status.expect.status);
                    expect(result.final).toBe(status.expect.status !== 'PENDING' && status.expect.status !== 'AUTHORIZED');
                    if (status.expect.refundedAmount !== undefined) {
                        expect(result.refundedAmount).toBe(status.expect.refundedAmount);
                    }
                    if (status.expect.amount !== undefined) {
                        expect(result.amount).toBe(status.expect.amount);
                    }
                    expect(result.ref.orderId).toBe(fixtures.ref.orderId);
                    expect(typeof result.providerStatus).toBe('string');
                });
            }

            it('rechaza una ref de otra pasarela', async () => {
                mockFetch([]);
                await expect(
                    fixtures.adapter().getStatus({ ...fixtures.ref, provider: 'otra' }),
                ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: 'ref' });
            });
        });

        describe('handleReturn', () => {
            for (const scenario of fixtures.returns) {
                it(scenario.name, async () => {
                    mockFetch(scenario.responses ?? []);
                    const promise = fixtures.adapter().handleReturn(fixtures.ref, scenario.request);
                    if (scenario.expect === 'RETURN_MISMATCH') {
                        await expect(promise).rejects.toMatchObject({ code: 'RETURN_MISMATCH' });
                    } else {
                        const result = await promise;
                        expect(result.status).toBe(scenario.expect);
                        expect(result.ref.orderId).toBe(fixtures.ref.orderId);
                    }
                });
            }
        });

        describe('operaciones no soportadas', () => {
            it('fallan con NOT_SUPPORTED sin salir a la red', async () => {
                const adapter = fixtures.adapter();
                const calls = mockFetch([]);
                if (!adapter.capabilities.capture) {
                    await expect(adapter.capture(fixtures.ref)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
                }
                if (!adapter.capabilities.cancel.unpaid && !adapter.capabilities.cancel.authorized) {
                    await expect(adapter.cancel(fixtures.ref)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
                }
                if (adapter.capabilities.notifications.delivery === 'none') {
                    await expect(adapter.handleNotification({ method: 'POST', url: '/', headers: {} })).rejects.toMatchObject({
                        code: 'NOT_SUPPORTED',
                    });
                }
                expect(calls).toHaveLength(0);
            });

            it('el webhook respeta su modo: requerido falla sin URL, opcional y ninguno no la piden', async () => {
                const { notificationUrl: _omit, ...withoutUrl } = fixtures.createInput;
                const { mode } = fixtures.adapter().capabilities.notifications;
                const adapter = (fixtures.adapterWithoutDefaultUrl ?? fixtures.adapter)();
                if (mode === 'required') {
                    const calls = mockFetch([]);
                    await expect(adapter.create(withoutUrl)).rejects.toMatchObject({
                        code: 'MISSING_FIELD',
                        field: 'notificationUrl',
                    });
                    expect(calls).toHaveLength(0);
                } else {
                    mockFetch([fixtures.createResponse]);
                    const created = await adapter.create(withoutUrl);
                    expect(created.redirectUrl).toMatch(/^https?:\/\//);
                }
            });

            it('create con capture manual falla si la pasarela no lo soporta', async () => {
                const adapter = fixtures.adapter();
                if (adapter.capabilities.capture) return;
                mockFetch([]);
                await expect(adapter.create({ ...fixtures.createInput, capture: 'manual' })).rejects.toMatchObject({
                    code: 'NOT_SUPPORTED',
                });
            });
        });

        describe('errores del proveedor', () => {
            it('un cuerpo HTML se convierte en PROVIDER_ERROR con el HTTP original', async () => {
                mockFetch([{ status: 502, text: '<html>Bad Gateway</html>' }]);
                const error = await fixtures.adapter().getStatus(fixtures.ref).catch((e: unknown) => e);
                expect(isPaymentError(error)).toBe(true);
                expect(error).toMatchObject({
                    code: 'PROVIDER_ERROR',
                    provider: { httpStatus: 502, retryable: true },
                });
            });

            it('una falla de red es PROVIDER_ERROR reintentable', async () => {
                failingFetch(new TypeError('fetch failed'));
                await expect(fixtures.adapter().getStatus(fixtures.ref)).rejects.toMatchObject({
                    code: 'PROVIDER_ERROR',
                    provider: { retryable: true },
                });
            });

            it('un 401 no es reintentable', async () => {
                mockFetch([{ status: 401, body: { message: 'Not Authorized' } }]);
                await expect(fixtures.adapter().getStatus(fixtures.ref)).rejects.toMatchObject({
                    code: 'PROVIDER_ERROR',
                    provider: { httpStatus: 401, retryable: false },
                });
            });
        });

        describe('raw', () => {
            it('por defecto incluye rawResponse y omite rawRequest', async () => {
                mockFetch([fixtures.paidResponse]);
                const result = await fixtures.adapter().getStatus(fixtures.ref);
                expect(result.rawResponse).toBeDefined();
                expect(result.rawRequest).toBeUndefined();
            });
        });
    });
}
