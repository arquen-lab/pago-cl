## Qué cambia

<!-- Qué problema resuelve o qué agrega, en pocas líneas. Enlaza el issue: Closes #123 -->

## Tipo

- [ ] Corrección de bug
- [ ] Mejora o funcionalidad nueva
- [ ] Pasarela nueva
- [ ] Documentación / tests / mantenimiento

## Pasarela(s) afectada(s)

<!-- transbank, flow, mercadopago, venti, getnet, klap, khipu, fintoc, o "ninguna" -->

## Cómo se probó

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build` pasan
- [ ] Agregué o actualicé tests (un bug lleva un test que fallaba antes)
- [ ] Probé contra el sandbox de la pasarela (`pnpm test:integration`), o indico abajo por qué no

## Lista de verificación

- [ ] Actualicé `CHANGELOG.md` bajo `## Sin publicar` si cambia lo que ve quien usa el SDK
- [ ] Actualicé `README.md` y `docs/` si cambia configuración, capacidades o webhooks
- [ ] Enlacé la documentación de la pasarela que respalda el cambio
- [ ] No incluí credenciales, claves ni datos reales de clientes

## Notas para quien revisa

<!-- Decisiones, dudas, lo que no pude probar. -->
