# <img src="https://www.google.com/s2/favicons?domain=khipu.com&sz=64" width="28" align="center" alt=""> Khipu

[Sitio](https://khipu.com) · [Documentación de la pasarela](https://docs.khipu.com) · [Todas las pasarelas](README.md)

`provider: 'khipu'` · Webhook: opcional ([qué significa](../webhooks.md))

## Configuración

`env`: `{ apiKey, webhookSecret? }`. La cuenta de cobro en modo desarrollador es el sandbox.

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'khipu',
    env: { apiKey, webhookSecret },   // webhookSecret solo para verificar webhooks
});

const { ref, redirectUrl } = await payments.create({ orderId, amount, returnUrl });   // CLP, UF o USD
const result = await payments.handleReturn(ref, await fromWebRequest(request));
// El retorno no trae datos y llega antes de que el banco concilie: puede ser PENDING.
const { result: notified, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook opcional: avisa la conciliación
await payments.getStatus(ref);                     // o consulta hasta que sea final
await payments.cancel(ref);                        // solo si aún no se pagó
const refunded = await payments.refund(ref, { amount: 5000 });   // parcial o total; hasta 180 días
await payments.getRefund(refunded.refund);
// Sin capture().
```

## Qué tener en cuenta

- Webhook opcional: solo avisa la conciliación exitosa, firmada con `x-khipu-signature` (necesita `webhookSecret`).
- El retorno no trae datos y llega antes de que el banco concilie, así que `handleReturn` puede devolver `PENDING`. El estado final llega por webhook o por `getStatus`.
- Un cobro pendiente que pasó su fecha de expiración se informa `EXPIRED`.
- Acepta CLP, UF y USD. El reembolso necesita habilitación de Khipu, es asíncrono y llega a 180 días.
