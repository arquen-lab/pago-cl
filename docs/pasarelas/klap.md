# <img src="https://www.google.com/s2/favicons?domain=klap.cl&sz=64" width="28" align="center" alt=""> Klap Checkout

[Sitio](https://www.klap.cl) · [Documentación de la pasarela](https://developers.klap.cl) · [Todas las pasarelas](README.md)

`provider: 'klap'` · Webhook: requerido ([qué significa](../webhooks.md))

## Configuración

`env`: `{ apiKey, environment?, notificationUrl? }`. La API key pública de pruebas está en https://developers.klap.cl/datos-de-prueba.

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'klap',
    env: { apiKey, notificationUrl: 'https://shop.example/webhooks/klap' },   // debe ser una URL pública
});

const { ref, redirectUrl } = await payments.create({ orderId, amount: 15000, returnUrl });   // de 50 a 99.999.999 CLP
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook requerido: confirma el pago
await payments.getStatus(ref);
await payments.refund(ref, { amount: 5000 });   // parcial o total
// Sin capture(), cancel() ni getRefund().
```

## Qué tener en cuenta

- Webhook requerido, y es el que confirma el pago. Responde con `reply` tal cual y en menos de 10 segundos, porque si no Klap reversa el cobro. Un pago aprobado cuyo webhook no se confirma queda `CANCELED`, con el motivo en `statusDetail`.
- La `notificationUrl` tiene que ser pública. Con una URL local, `create` falla con `INVALID_INPUT`.
- El SDK registra dos URLs por orden (`?kind=confirm` y `?kind=reject`). `extras.rejectNotificationUrl` manda los rechazos a otro endpoint.
- Montos de 50 a 99.999.999 CLP. Reembolso total o parcial.
