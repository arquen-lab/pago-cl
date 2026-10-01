# <img src="https://www.google.com/s2/favicons?domain=transbank.cl&sz=64" width="28" align="center" alt=""> Transbank Webpay Plus

[Sitio](https://www.transbank.cl) · [Documentación de la pasarela](https://www.transbankdevelopers.cl) · [Todas las pasarelas](README.md)

`provider: 'transbank'` · Webhook: ninguno ([qué significa](../webhooks.md))

## Configuración

`env`: `{ commerceCode, apiKey, environment?, deferredCommerceCode?, deferredApiKey? }`

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'transbank',
    env: {
        commerceCode, apiKey,
        deferredCommerceCode, deferredApiKey,   // solo para captura diferida: otro código de comercio y otra llave
    },
});

const { ref, redirectUrl } = await payments.create({ orderId, amount, returnUrl, capture: 'manual' });   // sin capture: cobro inmediato
const result = await payments.handleReturn(ref, await fromWebRequest(request));   // AUTHORIZED con captura manual, PAID si no
await payments.getStatus(ref);                  // hasta 7 días
await payments.capture(ref);                    // o capture(ref, 5000) para un monto parcial; dentro de 7 días
await payments.refund(ref, { amount: 5000 });   // anula o reembolsa; parcial según la tarjeta; sale en el acto
// Sin webhook, sin cancel() y sin getRefund().
```

## Qué tener en cuenta

- Webhook: no existe. El resultado sale de `handleReturn` y de `getStatus` (disponible por 7 días).
- Captura diferida: necesita otro código de comercio (`deferredCommerceCode`) con su propia llave (`deferredApiKey`). La llave es obligatoria en producción; en sandbox, si falta, se usa `apiKey`.
- `refund` anula o reembolsa según corresponda. El reembolso parcial depende de la tarjeta y se resuelve al instante.
- Solo acepta CLP.
