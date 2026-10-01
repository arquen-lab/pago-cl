import {invalidInput} from './errors';
import type {Currency} from './types';

/** Decimales admitidos por moneda. */
export const CURRENCY_PRECISION: Record<Currency, number> = {
    CLP: 0,
    UF: 4,
    USD: 2,
};

export function readCurrency(value: string | undefined, fallback: Currency = 'CLP'): Currency {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'CLP' || normalized === 'UF' || normalized === 'USD') {
        return normalized;
    }
    if (normalized === 'CLF') {
        return 'UF';
    }
    return fallback;
}

export function resolveCurrency(allowed: readonly Currency[], currency: Currency | undefined, provider: string): Currency {
    const resolved = currency ?? 'CLP';
    if (!allowed.includes(resolved)) {
        throw invalidInput('currency', `${provider} no acepta ${resolved}. Acepta: ${allowed.join(', ')}.`);
    }
    return resolved;
}

export function assertAmount(amount: number, currency: Currency, field = 'amount'): void {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw invalidInput(field, 'El monto tiene que ser un número mayor a cero.');
    }
    const precision = CURRENCY_PRECISION[currency];
    const scaled = amount * 10 ** precision;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
        throw invalidInput(
            field,
            precision === 0
                ? `${currency} no admite decimales.`
                : `${currency} admite hasta ${precision} decimales.`,
        );
    }
}

/** Unidades menores (por ejemplo UF × 10 000 para Venti). */
export function toMinorUnits(amount: number, currency: Currency): number {
    return Math.round(amount * 10 ** CURRENCY_PRECISION[currency]);
}

export function fromMinorUnits(minor: number, currency: Currency): number {
    return minor / 10 ** CURRENCY_PRECISION[currency];
}
