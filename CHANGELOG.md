# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado con [SemVer](https://semver.org/lang/es/).

## Sin publicar

- `capabilities.notifications.mode` (`none` | `optional` | `required`): dice si el webhook es necesario. El contrato exige que un webhook requerido falle sin URL y que uno opcional no la pida.
- `PROVIDER_INFO`: nombre, sitio, documentación y logo de cada pasarela.

## 0.0.1

Primera versión.

### Contrato

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
