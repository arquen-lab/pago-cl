# <img src="https://www.google.com/s2/favicons?domain=ventipay.com&sz=64" width="28" align="center" alt=""> Venti

[Sitio](https://ventipay.com) · [Documentación de la pasarela](https://docs.ventipay.com) · [Todas las pasarelas](README.md)

`provider: 'venti'` · Webhook: opcional ([qué significa](../webhooks.md))

## Configuración

`env`: `{ apiKey, webhookSecret? }`. La clave define si es modo de prueba o real.

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'venti',
    env: { apiKey, webhookSecret },   // la clave define el modo de prueba o real
});

const { ref, redirectUrl } = await payments.create({
    orderId, amount, returnUrl,       // currency: 'UF' también
    capture: 'manual',                // opcional: autoriza y se cobra después
});
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, refund, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook opcional
await payments.getStatus(ref);
await payments.capture(ref);          // dentro de 10 minutos; solo el monto completo
await payments.cancel(ref);           // sin pagar, o una autorización sin capturar
const refunded = await payments.refund(ref, { amount: 5000 });   // parcial o total
await payments.getRefund(refunded.refund);
```

## Qué tener en cuenta

- Webhook opcional: la plataforma autoriza el pago sin él. Con firma `venti-signature` (necesita `webhookSecret`). `extras.notificationEvents` elige los eventos.
- Captura manual: autoriza primero y se cobra dentro de 10 minutos, solo por el monto completo.
- Se puede cancelar sin pagar o una autorización sin capturar. El reembolso es asíncrono y admite monto parcial.
- Acepta CLP y UF.
