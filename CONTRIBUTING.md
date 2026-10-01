# Cómo contribuir

¡Gracias por querer mejorar `pago-cl-sdk`! Aquí vale todo: arreglar un bug, corregir un texto o sumar una pasarela nueva. Al participar aceptas el [código de conducta](CODE_OF_CONDUCT.md).

## Antes de empezar

- Para un bug o una idea chica, abre un issue (hay plantillas). Si ya sabes la solución, manda el PR directo.
- Para un cambio grande (pasarela nueva, cambio del contrato, operaciones nuevas), abre primero un issue y acordemos el enfoque antes de escribir código.
- Las vulnerabilidades no van por issue público. Usa [SECURITY.md](SECURITY.md).
- No subas credenciales, ni siquiera de sandbox, en código, tests, issues o logs. Van en `.env` (git lo ignora) y sus nombres en `.env.example`.

## Preparar el entorno

Necesitas Node 20 o superior y [pnpm](https://pnpm.io) 11.

```sh
git clone https://github.com/arquen-lab/pago-cl.git
cd pago-cl
pnpm install
cp .env.example .env     # solo si vas a correr las pruebas de integración
```

| Comando | Qué hace |
|---|---|
| `pnpm test` | Unitarios y de contrato con respuestas grabadas. Sin red ni credenciales |
| `pnpm test:integration` | Crea pagos reales en cada sandbox; se salta lo que no tenga credenciales en `.env` |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm typecheck` | TypeScript del código y de los tests |
| `pnpm build` | Compila a `dist/` |

Un PR tiene que pasar `lint`, `typecheck`, `test` y `build`. El CI los corre en Node 20, 22 y 24, y además hace la auditoría de dependencias, CodeQL y la revisión de dependencias nuevas. Las acciones de GitHub van fijadas por SHA y Dependabot las actualiza.

## Flujo de un pull request

1. Haz un fork y crea una rama desde `main`: `fix/klap-expiracion`, `feat/payku`, `docs/readme`.
2. Haz el cambio con tests. Si es un bug, agrega un test que fallaba antes del arreglo.
3. Si cambia lo que ve quien usa el SDK, agrega una línea en `CHANGELOG.md` bajo `## Sin publicar`.
4. Corre `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
5. Abre el PR contra `main` y completa la plantilla. Un PR chico y de un solo tema se revisa más rápido.
6. Responde a la revisión con commits nuevos. Al final el merge es *squash*.

### Commits

Los commits siguen [Conventional Commits](https://www.conventionalcommits.org/es/), en español o inglés: `feat(klap): reembolso parcial`, `fix(khipu): estado deleted`, `docs: guía de webhooks`, `test:`, `refactor:`, `chore:`.

## Estilo de código

- TypeScript estricto. Un comentario explica el porqué o una regla de la pasarela, no lo que el código ya dice.
- Las reglas de cada pasarela viven en su `api.ts` con el enlace a la documentación que las respalda.
- Los mensajes de error y la documentación van en español. El código, en inglés.
- Biome es el linter. Si desactivas una regla con un comentario, explica el motivo ahí mismo.

## Agregar una pasarela

Todas las pasarelas siguen la misma estructura. Usa `src/providers/khipu/` como referencia.

```
src/providers/<id>/
  api.ts        # constantes de la API: hosts, rutas, tipos de respuesta, mapa de estados. Enlaza la documentación
  core.ts       # config + clase *Core: headers, parseError, request(), verificación de webhooks
  checkout.ts   # el producto: implementa CheckoutProduct (create, handleReturn, handleNotification, getStatus, ...)
test/providers/<id>.test.ts
```

1. En `api.ts`, traduce los estados del proveedor a los comunes (`PENDING`, `AUTHORIZED`, `PAID`, `REJECTED`, `CANCELED`, `EXPIRED`).
2. En `core.ts`, exporta `<Id>Config` y una clase que implemente `ProviderHttp`. Todas las llamadas pasan por `callProvider`, así el timeout y el `PROVIDER_ERROR` son iguales en todas.
3. En `checkout.ts`, declara `capabilities` y `extrasSchema` con lo que la pasarela realmente soporta. Lo que no soporte lanza `NOT_SUPPORTED` antes de llamar a la API.
4. Regístrala en `src/create-payment-adapter.ts` (`ProviderEnv`, `ProviderCheckoutExtras`, `PROVIDER_IDS`, `factories`) y exporta sus tipos en `src/index.ts`.
5. Escribe los tests: pasa `describeCheckoutContract` (`test/contract/checkout-contract.ts`) con respuestas grabadas y agrega casos propios de firma de webhook, estados y errores.
6. Si hay sandbox, agrega un bloque en `test/integration/sandbox.integration.test.ts` y las variables vacías en `.env.example`. Esas pruebas encuentran bugs que los mocks no ven.
7. Agrégala a `PROVIDER_INFO` (`src/providers/info.ts`) con su sitio y su documentación. Un test exige que todas estén.
8. Declara `capabilities.notifications.mode` (`none`, `optional` o `required`) según su documentación. Si el pago se confirma sin webhook, es `optional`. El contrato lo verifica.
9. Documéntala: súmala a la tabla del `README.md` y a `docs/pasarelas/README.md`, crea su página en `docs/pasarelas/<id>.md` (copia una existente), agrega sus notas en `docs/webhooks.md` y anótala en el `CHANGELOG.md`.

En el PR cuenta qué documentación usaste y qué pudiste probar en sandbox y qué no.

## Publicar una versión (mantenedores)

1. Mueve lo de `## Sin publicar` a una sección nueva `## X.Y.Z` en `CHANGELOG.md` y sube `version` en `package.json` ([SemVer](https://semver.org/lang/es/); en `0.x` un cambio de contrato puede ir en un minor).
2. Commit a `main`: `chore: release X.Y.Z`.
3. Crea y sube el tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

El workflow `Release` espera tu aprobación en el entorno `npm`. Después verifica que el tag coincida con `package.json`, corre todas las comprobaciones, publica en npm y crea el GitHub Release con las notas del changelog. La publicación usa trusted publishing: npm autentica al workflow por OIDC, sin token, y cada versión queda con provenance que enlaza a este repositorio. Una versión con sufijo (`0.1.0-beta.1`) sale con el dist-tag `next` y como pre-release.

## Licencia

Al enviar un aporte aceptas que se publique bajo la [licencia MIT](LICENSE) del proyecto.
