# Crypto Reca Dashboard

Aplicación web/PWA de seguimiento de **Crypto Reca v3.0**.

## Producción

- URL: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Repositorio: `Tresviulk/crypto-reca-dashboard`
- Rama de producción: `main`
- Despliegue: GitHub Pages mediante GitHub Actions
- App objetivo actual: `0.4.5`

## Qué hace

- Radar con D/E, Pullback/Momentum, ERS determinista, Entry Engine y decisión contemporánea.
- System Health con PASS / PARTIAL / FAIL por módulo.
- Decision Matrix: ERS + Entry + tendencia 15m/1H/4H/1D + PRS + noticias + señales externas sin promediarlas.
- Ficha por activo, Centro de Oportunidades, Risk Dashboard, journal, analítica y timeline.
- Position Risk / Exit Advisory con HOLD / WATCH / REDUCE REVIEW / EXIT REVIEW / EXIT SIGNAL.
- Protection Assistant y Scenario Lab para posiciones abiertas.
- Correlation & Cluster Risk para evitar falsa diversificación entre activos cripto.
- News & Catalysts de alta señal.
- Gurús / Señales externas con validación forward, no por popularidad o win-rate auto-reportado.
- Shadow Portfolio para congelar PREPARE/rechazos contemporáneos y evaluar después los filtros sin hindsight.
- Precio y gráficos públicos de Coinbase, más indicadores técnicos de visualización cuando hay muestra suficiente.
- PWA instalable y cache de interfaz para uso offline/degradado.

## Reparación ERS

La especificación canónica de D/E y ERS vive en `docs/ENGINE_SPEC_V3_ERS.md`. Si existen datos core 1D/4H/1H suficientes, el motor debe producir scores numéricos; si no puede hacerlo, la app muestra `ERS NO CALCULADO` y System Health lo marca PARTIAL/FAIL. Nunca se reutiliza un score antiguo.

## Arquitectura de datos v2

Se elimina el riesgo de varios escritores compitiendo sobre un único JSON. Los datos se separan por autoridad:

- `data/radar-state.json` — Radar, ERS, Entry Engine, history, audits, Shadow Portfolio.
- `data/positions-state.json` — posiciones/ledger confirmados por Coinbase y usuario.
- `data/position-risk.json` — PRS y risk history.
- `data/intelligence.json` — noticias/catalizadores.
- `data/external-signals.json` — señales externas y validación de fuentes.
- `data/crypto-reca-state.json` — compatibilidad legacy durante migración; deja de ser escritor rutinario cuando todos los módulos estén migrados.

La PWA carga primero el snapshot legacy y después superpone módulos no vacíos. Así una migración parcial no borra datos confirmados.

## Qué NO hace

- No contiene claves de Coinbase.
- No accede a saldo privado ni órdenes autenticadas de Coinbase.
- No ejecuta compras, ventas ni stops.
- No considera una recomendación como fill.
- No considera un stop recomendado como protección real.
- No reconstruye ERS/Entry/stop/target históricos con hindsight.
- No convierte noticias o gurús en una compra/venta automática.

## Archivos principales

- `app.js` — núcleo base.
- `radar-time.js` — frescura del radar.
- `features-v04.js` — capa funcional previa v0.4.
- `live-indicators-v04.js` — indicadores públicos de visualización.
- `trend-v04.js` — tendencia multitemporal.
- `position-risk-v04.js` — UI de PRS.
- `news-v04.js` — UI de noticias/catalizadores.
- `ers-display-v04.js` — representación explícita de ERS faltante.
- `module-loader-v04.js` — carga modular, System Health y registro único de nuevas pantallas/acciones.
- `decision-v04.js` — Decision Matrix + correlación/cluster risk.
- `risk-tools-v04.js` — Protection Assistant + Scenario Lab.
- `research-v04.js` — Gurús/External Signals + Shadow Portfolio.
- `architecture-v04.css` — estilos de saneamiento estructural.
- `docs/ENGINE_SPEC_V3_ERS.md` — rulebook canónico ERS.
- `docs/DATA_CONTRACT.md` — contrato modular v2.

## Regla de cambios

Cambio funcional: rama → validación → revisión → merge a `main` → comprobación de Pages.

Cambios operativos: cada writer toca **solo su archivo modular**. Los fills/protección reales solo se actualizan con evidencia contemporánea confirmada.

Antes de trabajar con otra IA, leer `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md`, `docs/ENGINE_SPEC_V3_ERS.md` y `CHANGELOG.md`.
