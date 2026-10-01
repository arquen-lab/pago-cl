# <img src="https://www.google.com/s2/favicons?domain=flow.cl&sz=64" width="28" align="center" alt=""> Flow

[Sitio](https://www.flow.cl) · [Documentación de la pasarela](https://developers.flow.cl) · [Todas las pasarelas](README.md)

`provider: 'flow'` · Webhook: requerido ([qué significa](../webhooks.md))

## Configuración

`env`: `{ apiKey, secretKey, environment?, notificationUrl? }`

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'flow',
    env: { apiKey, secretKey, notificationUrl: 'https://shop.example/webhooks/flow' },   // obligatoria: aquí o en cada create
});

const { ref, redirectUrl } = await payments.create({
    orderId, amount, returnUrl,                      // currency: 'UF' también
    customer: { email: 'customer@example.com' },     // lo exige Flow
});
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, refund, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook requerido
await payments.getStatus(ref);
const refunded = await payments.refund(ref, { amount: 5000 });   // receiverEmail sale del customer.email del cobro
await payments.getRefund(refunded.refund);                        // el reembolso es asíncrono
// Sin capture() ni cancel().
```

## Qué tener en cuenta

- Webhook requerido: `notificationUrl` va en el `env` o en cada `create`. Si falta, `create` falla con `MISSING_FIELD`.
- `customer.email` es obligatorio. El reembolso usa ese email como `receiverEmail`, salvo que lo pases en `refund`.
- El reembolso es asíncrono: consulta su estado con `getRefund`.
- Acepta CLP y UF.
