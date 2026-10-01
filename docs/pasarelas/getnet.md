# <img src="https://www.google.com/s2/favicons?domain=getnet.cl&sz=64" width="28" align="center" alt=""> Getnet Web Checkout

[Sitio](https://www.getnet.cl) · [Documentación de la pasarela](https://www.getnet.cl) · [Todas las pasarelas](README.md)

`provider: 'getnet'` · Webhook: opcional ([qué significa](../webhooks.md))

## Configuración

`env`: `{ login, secretKey, environment? }`

`environment` es `'sandbox'` por defecto, o `'production'`.

## Ejemplo

El resto del flujo es el mismo que en el [uso básico](../uso.md). Aquí están todos los métodos que esta pasarela soporta. Los que no aparecen no existen en ella y fallan con `NOT_SUPPORTED`.

```ts
const payments = createPaymentAdapter({
    provider: 'getnet',
    env: { login, secretKey },
});

const { ref, redirectUrl } = await payments.create({
    orderId, amount, returnUrl,
    client: { ip: request.ip, userAgent: request.headers['user-agent'] },   // obligatorio: los del comprador
});
const result = await payments.handleReturn(ref, await fromWebRequest(request));
const { result: notified, reply } = await payments.handleNotification(await fromWebRequest(request));   // webhook opcional; la URL se registra con Getnet
await payments.getStatus(ref);
await payments.refund(ref);                 // solo reverso total, sin amount
// Sin capture(), cancel() ni getRefund().
```

## Qué tener en cuenta

- `client.ip` y `client.userAgent` son obligatorios y tienen que ser los del comprador.
- Webhook opcional, con firma en el cuerpo. La URL no se manda por cobro: se registra con Getnet en el formulario de validación.
- El reembolso es solo total (reverso).
- Solo acepta CLP.
