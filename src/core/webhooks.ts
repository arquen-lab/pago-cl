import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export function hmacSha256Hex(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSha256Base64(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64');
}

export function sha256Hex(payload: string): string {
    return createHash('sha256').update(payload).digest('hex');
}

/** Comparación en tiempo constante. false si los largos difieren. */
export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/** Lee headers tipo `t=1700000000,v1=abcd` en un mapa. */
export function parseSignatureHeader(value: string | undefined): Record<string, string> {
    const parts: Record<string, string> = {};
    if (!value) return parts;
    for (const piece of value.split(',')) {
        const index = piece.indexOf('=');
        if (index <= 0) continue;
        parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
    }
    return parts;
}

/** true si `timestamp` (segundos o milisegundos) está dentro de la tolerancia. */
export function withinTolerance(timestamp: string | number | undefined, toleranceSeconds: number, now = Date.now()): boolean {
    if (timestamp === undefined) return false;
    let value = Number(timestamp);
    if (!Number.isFinite(value)) return false;
    if (value < 1e11) value *= 1000; // venía en segundos
    return Math.abs(now - value) <= toleranceSeconds * 1000;
}
