# AI HANDOFF — Crypto Reca Dashboard

## 1. Identidad del proyecto

Este repositorio contiene la aplicación web/PWA **Crypto Reca Dashboard**.

- Repositorio oficial: `Tresviulk/crypto-reca-dashboard`
- Producción: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Rama de producción: `main`
- Motor de trading referenciado: **Crypto Reca v3.0**
- App objetivo actual: **0.4.0**

## 2. Instrucción obligatoria para cualquier IA o desarrollador

Antes de modificar nada:

1. Leer `README.md`.
2. Leer este archivo completo.
3. Leer `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`.
4. Leer `docs/DATA_CONTRACT.md`.
5. Leer `CHANGELOG.md`.
6. Inspeccionar los archivos actuales en GitHub; no reconstruir la app desde memoria, capturas o versiones antiguas.

## 3. Reglas de preservación

- No modificar funcionalidades no solicitadas.
- No sobrescribir decisiones, posiciones, fills o ledger sin evidencia contemporánea.
- No inventar precios, scores, timestamps, órdenes ni ejecuciones.
- No convertir una recomendación en una orden ejecutada.
- No introducir claves, tokens, API secrets ni credenciales de Coinbase en el frontend, GitHub o documentación.
- No llamar "live Coinbase account" a datos obtenidos de endpoints públicos.
- Para cambios funcionales relevantes, trabajar en rama separada y revisar antes de merge a `main`.
- Los cambios puramente operativos de `data/crypto-reca-state.json` pueden hacerse directamente en `main` si respetan el contrato y provienen de un scan/confirmación contemporánea.

## 4. Fuente de verdad y módulos

La app separa código de datos.

- UI/núcleo: `index.html`, `styles.css`, `app.js`.
- Timestamp/frescura: `radar-time.js`.
- Funcionalidades v0.4: `features-v04.js` + `features-v04.css`.
- Indicadores públicos de visualización: `live-indicators-v04.js`.
- Estado operativo visible: `data/crypto-reca-state.json`.
- Service worker: `sw.js`.

El frontend puede calcular indicadores públicos para visualización usando velas Coinbase. Esos valores deben etiquetarse como **LIVE/CALCULATED** y nunca sustituir silenciosamente a los indicadores contemporáneos del motor Crypto Reca.

## 5. Funcionalidades v0.4

- Radar con timestamp y frescura.
- Ficha completa por activo.
- Centro de oportunidades.
- Risk Dashboard.
- Alertas internas.
- Journal automático.
- Analítica del sistema.
- Timeline de posiciones.
- Histórico gráfico ERS / Entry Engine.
- Actualización manual.
- Etiquetas de procedencia de datos.

Si no existe muestra suficiente, mostrarlo explícitamente. No fabricar win rates, probabilidades ni conclusiones estadísticas.

## 6. Sincronización automática

El radar horario de ChatGPT **Crypto Reca v3.0 Radar** debe, después de completar cada scan, actualizar `data/crypto-reca-state.json` si la conexión GitHub está disponible.

La sincronización nunca debe bloquear el scan. Si GitHub falla, el resultado del radar sigue siendo válido y debe indicar que la app no se pudo sincronizar.

En cada sync:

- actualizar `generatedAt`, `source` y `scan`;
- actualizar los seis registros del `radar` con los valores realmente calculados;
- añadir un registro compacto a `history`;
- conservar posiciones, ledger, journal y auditorías salvo cambio contemporáneo confirmado;
- limitar `history` a los últimos 168 scans horarios salvo decisión distinta documentada;
- en el scan diario de auditoría, añadir/actualizar la entrada correspondiente en `audits`.

Campos detallados del radar como `indicators`, `structure` o `entryDimensions` solo pueden escribirse si fueron calculados contemporáneamente en ese mismo run.

## 7. Cambios de posiciones reales

Cuando el usuario confirme un fill, salida, stop colocado o modificación real:

1. comprobar la evidencia disponible;
2. actualizar la lógica/registro de Crypto Reca;
3. actualizar `positions` y/o `ledger` en `data/crypto-reca-state.json`;
4. no borrar el histórico previo;
5. registrar el cambio en `journal` si aporta trazabilidad;
6. registrar el cambio en `CHANGELOG.md` solo si supone cambio de app/arquitectura; los fills normales no requieren bump de versión.

## 8. Deployment

GitHub Pages se despliega desde `main` mediante `.github/workflows/deploy-pages.yml`.

Un merge o commit en `main` activa el deployment. La PWA tiene service worker. Si se cambia código estático, incrementar la constante `CACHE` de `sw.js` y, si corresponde, la versión visible de app.

## 9. Rollback

Si una versión rompe producción:

- identificar el último commit bueno en `main`;
- revertir el commit o crear una rama desde el commit bueno;
- no borrar el historial Git;
- comprobar que `data/crypto-reca-state.json` no pierde fills/ledger posteriores al rollback de código.

## 10. Seguridad

El repositorio y GitHub Pages son públicos. Por tanto:

- nunca guardar secretos;
- no guardar datos personales innecesarios;
- no exponer claves API;
- no habilitar trading privado desde el navegador;
- cualquier futura integración autenticada con Coinbase debe usar backend seguro/secret manager y permisos mínimos, preferiblemente read-only inicialmente.

La v0.4 sigue siendo read-only. Las funciones que requieren backend privado no deben simularse: autenticación, balances privados automáticos, órdenes privadas, push seguro y ejecución automática.

## 11. Prompt recomendado para otra IA

> Trabaja sobre mi aplicación Crypto Reca Dashboard en el repositorio `Tresviulk/crypto-reca-dashboard`. Antes de modificar nada, lee `README.md`, `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md` y `CHANGELOG.md`, y revisa el código actual del repositorio. No reconstruyas la aplicación desde cero ni cambies funcionalidades no solicitadas. Analiza primero riesgos e impacto. Para cambios funcionales, usa una rama separada, comprueba que no rompa la versión actual y actualiza documentación y CHANGELOG antes de pasar a `main`. Mantén separados datos LIVE públicos, datos del ÚLTIMO SCAN y datos CONFIRMADOS COINBASE. No introduzcas secretos ni credenciales en el frontend. Mi cambio solicitado es: [DESCRIBIR CAMBIO].
