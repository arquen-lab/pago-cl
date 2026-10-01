import {randomUUID} from 'node:crypto';
import {invalidInput} from './errors';

/** Mínimo común entre pasarelas: Transbank 26, Getnet 32 y sin símbolos raros. */
export const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,26}$/;

export function assertOrderId(orderId: string): string {
    if (!ORDER_ID_PATTERN.test(orderId)) {
        throw invalidInput('orderId', 'orderId admite hasta 26 caracteres: letras, números, "-" y "_".');
    }
    return orderId;
}

export function generateOrderId(): string {
    return randomUUID().replaceAll('-', '').slice(0, 26);
}

export function generateRefundId(): string {
    return `ref_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}
