# Seguridad

Este SDK maneja claves de pasarelas de pago y verifica notificaciones firmadas, así que una vulnerabilidad puede tener consecuencias reales.

## Cómo reportar una vulnerabilidad

No abras un issue público. Usa el reporte privado de GitHub:
[Security → Report a vulnerability](https://github.com/arquen-lab/pago-cl/security/advisories/new).

Incluye la versión, el `provider` afectado, los pasos para reproducirlo y el impacto que ves. Responderemos lo antes posible y coordinaremos contigo la corrección y la publicación del aviso.

## Qué cubre

- Fallos en la verificación de firmas o de retornos (`VERIFICATION_FAILED`, `RETURN_MISMATCH`).
- Filtración de credenciales en errores, logs o `rawRequest` / `rawResponse`.
- Montos u órdenes que puedan manipularse entre el cobro y la confirmación.

Los problemas de las pasarelas en sí (Transbank, Flow, etc.) se reportan a cada proveedor.

## Versiones con soporte

Mientras el SDK esté en `0.x`, solo se corrige la última versión publicada.

## Si subiste una credencial por error

Rótala en la pasarela de inmediato: borrar el commit no basta. Después avisa a los mantenedores para limpiar el historial.
