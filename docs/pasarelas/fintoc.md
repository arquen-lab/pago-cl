# <img src="https://www.google.com/s2/favicons?domain=fintoc.com&sz=64" width="28" align="center" alt=""> Fintoc

[Sitio](https://fintoc.com) · [Documentación de la pasarela](https://docs.fintoc.com) · [Todas las pasarelas](README.md)

`provider: 'fintoc'` · Webhook: opcional ([qué significa](../webhooks.md))

## Configuración

`env`: `{ secretKey, webhookSecret?, apiVersion? }`. Una clave `sk_test_...` es el sandbox.

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'fintoc',
    env: { secretKey, webhookSecret },   // sk_test_... es el sandbox
});

const { ref, redirectUrl } = await payments.create({
    orderId, amount, returnUrl,
    customer: { email: 'customer@example.com' },   // el email es opcional
});
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, refund, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook opcional; se registra en la cuenta
await payments.getStatus(ref);
await payments.cancel(ref);                         // solo si aún no se pagó
const refunded = await payments.refund(ref, { amount: 5000 });   // admite reembolso parcial
await payments.getRefund(refunded.refund);          // procesa a las 18:00
// Sin capture().
```

## Qué tener en cuenta

- Webhook opcional. Se registra una vez en tu cuenta de Fintoc (panel o `POST /v1/webhook_endpoints`), no por cobro. Firma `Fintoc-Signature` con `webhookSecret`.
- Fintoc no tiene campo para tu id de orden: el SDK lo guarda en `metadata.order_id` y lo verifica al consultar.
- El reembolso se hace sobre el `payment_intent` del pago y se procesa a las 18:00.
- Solo acepta CLP.
