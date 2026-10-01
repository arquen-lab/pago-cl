# <img src="https://www.google.com/s2/favicons?domain=mercadopago.cl&sz=64" width="28" align="center" alt=""> Mercado Pago Checkout Pro

[Sitio](https://www.mercadopago.cl) · [Documentación de la pasarela](https://www.mercadopago.cl/developers) · [Todas las pasarelas](README.md)

`provider: 'mercadopago'` · Webhook: opcional ([qué significa](../webhooks.md))

## Configuración

`env`: `{ accessToken, webhookSecret?, environment? }`

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'mercadopago',
    env: { accessToken, webhookSecret },   // webhookSecret solo para verificar webhooks
});

const { ref, redirectUrl } = await payments.create({
    orderId, amount, returnUrl,              // returnUrl debe ser https
    extras: { statementDescriptor: 'MY SHOP', binaryMode: true },
});
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook opcional
await payments.getStatus(ref);
await payments.cancel(ref);                         // solo si aún no se pagó
const refunded = await payments.refund(ref, { amount: 5000 });   // parcial o total, hasta 180 días
await payments.getRefund(refunded.refund);
// Sin capture().
```

## Qué tener en cuenta

- Webhook opcional, con firma `x-signature` (necesita `webhookSecret`). Los pagos de prueba no envían notificaciones.
- `returnUrl` tiene que ser https.
- Se puede cancelar mientras no se haya pagado. El reembolso admite monto parcial hasta 180 días después.
- Solo acepta CLP.
