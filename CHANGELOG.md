# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado con [SemVer](https://semver.org/lang/es/).

## Sin publicar

## 0.0.3

- Nueva opción `fetch` en la configuración de cada pasarela, con la firma estándar de `fetch` (tipo `FetchLike`, exportado). Si falta, se usa el `fetch` global, resuelto en cada llamada. Es aditiva: no cambia nada para quien no la use.
- El `apiKey` se envía tal cual, sin validarlo ni transformarlo (admite marcadores como `{{secret.apiSecret}}`) y no aparece en errores ni en la `PaymentRef`.
- `generateOrderId` usa `globalThis.crypto.randomUUID()` y la firma de Flow usa `URLSearchParams`: dos imports de Node menos (`node:crypto` y `node:querystring`). Quedan `node:crypto` y `Buffer` en webhooks y Getnet; en Workers hace falta `nodejs_compat`.

## 0.0.2

- Las versiones se publican desde GitHub Actions con trusted publishing: npm autentica al workflow por OIDC, sin token, y cada versión queda con provenance que enlaza a este repositorio.

## 0.0.1

Primera versión.

### Contrato

- `capabilities.notifications.mode` (`none` | `optional` | `required`): dice si el webhook es necesario. El contrato exige que un webhook requerido falle sin URL y que uno opcional no la pida.
- `PROVIDER_INFO`: nombre, sitio, documentación y logo de cada pasarela.
- `createPaymentAdapter({ provider, env })` es el único punto de entrada; el mismo código sirve para todas las pasarelas.
- Métodos uniformes: `create`, `handleReturn`, `handleNotification`, `getStatus`, `capture`, `cancel`, `refund` y `getRefund`. `create` devuelve `{ ref, redirectUrl }`; la `ref` (`PaymentRef`) se guarda con la orden y se usa en el resto.
- `capabilities` indica qué soporta cada pasarela y `extrasSchema` describe sus campos propios.
- Estados comunes: `PENDING`, `AUTHORIZED`, `PAID`, `REJECTED`, `CANCELED` y `EXPIRED`. `PaymentResult` incluye `refundedAmount`, `final`, `providerStatus` y `statusDetail`.
- Errores tipados: `INVALID_INPUT`, `MISSING_FIELD`, `NOT_SUPPORTED`, `PROVIDER_ERROR` (con `httpStatus`, `providerCode` y `retryable`), `RETURN_MISMATCH`, `VERIFICATION_FAILED` y `CONFIG_ERROR`.
- Input común: `customer`, `client`, `returnUrl`, `cancelUrl`, `notificationUrl`, `expiresAt`, `capture` y `metadata`.
- `environment` es `'sandbox' | 'production'` en todas las pasarelas.
- `fromWebRequest` convierte un `Request` estándar (fetch, Hono, Next).

### Pasarelas

- Transbank Webpay Plus, con captura diferida opcional (`deferredCommerceCode`, `deferredApiKey` y `create({ capture: 'manual' })`).
- Flow.
- Mercado Pago Checkout Pro.
- Venti Checkout, con captura manual y UF.
- Getnet Web Checkout.
- Klap Checkout.
- Khipu Pagos Instantáneos.
- Fintoc Checkout Session.

### Notificaciones

- Verificación de firma en Venti, Mercado Pago, Getnet, Khipu y Fintoc; reconsulta por token en Flow.
- Klap: la notificación de confirmación es el commit del pago.

### Calidad

- Suite de contrato compartida y respuestas grabadas por pasarela.
- Pruebas de integración contra sandbox, activadas por variables de entorno.
- Linter con Biome.
