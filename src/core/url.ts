/** true si la URL apunta a la máquina local: ninguna pasarela puede alcanzarla desde internet. */
export function isLocalUrl(value: string): boolean {
    try {
        const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
        return (
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            hostname.endsWith('.local') ||
            hostname === '::1' ||
            hostname === '0.0.0.0' ||
            /^127\./.test(hostname)
        );
    } catch {
        return false;
    }
}
