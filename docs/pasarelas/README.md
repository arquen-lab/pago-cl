# Pasarelas

Cada pasarela tiene su página con la configuración, un ejemplo con todos los métodos que soporta y lo que conviene saber antes de usarla.

| | Pasarela | `provider` | Webhook |
|---|---|---|---|
| <img src="https://www.google.com/s2/favicons?domain=transbank.cl&sz=64" width="20" alt=""> | [Transbank Webpay Plus](transbank.md) | `transbank` | ninguno |
| <img src="https://www.google.com/s2/favicons?domain=flow.cl&sz=64" width="20" alt=""> | [Flow](flow.md) | `flow` | requerido |
| <img src="https://www.google.com/s2/favicons?domain=mercadopago.cl&sz=64" width="20" alt=""> | [Mercado Pago](mercadopago.md) | `mercadopago` | opcional |
| <img src="https://www.google.com/s2/favicons?domain=ventipay.com&sz=64" width="20" alt=""> | [Venti](venti.md) | `venti` | opcional |
| <img src="https://www.google.com/s2/favicons?domain=getnet.cl&sz=64" width="20" alt=""> | [Getnet](getnet.md) | `getnet` | opcional |
| <img src="https://www.google.com/s2/favicons?domain=klap.cl&sz=64" width="20" alt=""> | [Klap](klap.md) | `klap` | requerido |
| <img src="https://www.google.com/s2/favicons?domain=khipu.com&sz=64" width="20" alt=""> | [Khipu](khipu.md) | `khipu` | opcional |
| <img src="https://www.google.com/s2/favicons?domain=fintoc.com&sz=64" width="20" alt=""> | [Fintoc](fintoc.md) | `fintoc` | opcional |

## Comparación

Lo que cada adapter declara en `payments.capabilities`. Si pides algo que la pasarela no soporta, falla con `NOT_SUPPORTED` antes de llamar a su API.

| | Monedas | Webhook | Verificación | Reembolso parcial | Reembolso asíncrono | Cancelar sin pagar | Captura diferida |
|---|---|---|---|---|---|---|---|
| [Transbank](transbank.md) | CLP | Ninguno | — | Según tarjeta | No | No | Con `deferredCommerceCode`, 7 días |
| [Flow](flow.md) | CLP, UF | Requerido, por cobro | Reconsulta | Sí | Sí | No | No |
| [Mercado Pago](mercadopago.md) | CLP | Opcional, por cobro o panel | Firma | Sí | No | Sí | No |
| [Venti](venti.md) | CLP, UF | Opcional, por cobro o API | Firma | Sí | Sí | Sí | Sí, 10 minutos |
| [Getnet](getnet.md) | CLP | Opcional, por cuenta (se configura con Getnet) | Firma | No, solo total | No | No | No |
| [Klap](klap.md) | CLP | Requerido, por cobro | Hash en header | Sí | No | No | No |
| [Fintoc](fintoc.md) | CLP | Opcional, por cuenta (API) | Firma | Sí, es una transferencia | Sí, procesa a las 18:00 | Sí | No |
| [Khipu](khipu.md) | CLP, UF, USD | Opcional, por cobro | Firma | Sí, con habilitación | Sí, se paga después | Sí | No |

## Captura diferida

Funciona distinto en cada pasarela, pero se pide igual: `create({ capture: 'manual' })` y después `capture(ref)`. En Transbank necesita otro código de comercio con su propia llave; en Venti es una opción por cobro.

## Campos que algunas pasarelas exigen

- Flow: `customer.email` y una `notificationUrl`, en el input o en `env`.
- Mercado Pago: `returnUrl` con https.
- Getnet: `client.ip` y `client.userAgent` del pagador.
- Klap: una `notificationUrl` pública y montos de 50 a 99.999.999 CLP.
