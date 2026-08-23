# Crypto Reca Dashboard

Aplicación web/PWA de seguimiento de **Crypto Reca v3.0**.

## Producción

- URL: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Repositorio: `Tresviulk/crypto-reca-dashboard`
- Rama de producción: `main`
- Despliegue: GitHub Pages mediante GitHub Actions
- App objetivo actual: `0.4.0`

## Qué hace

- Lee el estado operativo desde `data/crypto-reca-state.json`.
- Muestra radar, ERS, D/E, Entry Engine, posiciones, ledger y auditorías.
- Muestra fecha/hora exacta del último scan y separa esa hora de la actualización de precios públicos.
- Consulta precios y velas públicas de Coinbase cuando están disponibles.
- Calcula P/L no realizado con precio público en vivo.
- Calcula analítica técnica visual desde velas 1H completadas: EMA20/50/200, RSI14, MACD, ATR14, standard VWAP y RVOL.
- Incluye ficha completa por activo, Centro de Oportunidades, Risk Dashboard, alertas internas, journal, analítica e histórico/timeline.
- Funciona como PWA instalable y conserva una copia offline de la interfaz.

## Qué NO hace

- No contiene claves de Coinbase.
- No accede a saldo privado ni órdenes de Coinbase.
- No ejecuta compras, ventas ni stops.
- No sustituye la confirmación de ejecución en Coinbase Advanced.
- No presenta indicadores públicos calculados en el frontend como si fueran los valores contemporáneos usados por el motor de decisión.

## Arquitectura

- `index.html`: shell de la PWA.
- `styles.css`: estilos base.
- `features-v04.css`: estilos de la capa funcional v0.4.
- `app.js`: núcleo estable de lectura de datos, mercado público y UI base.
- `radar-time.js`: fecha/hora y frescura del radar.
- `features-v04.js`: oportunidades, riesgo, ficha por activo, alerts, journal, analytics y timeline.
- `live-indicators-v04.js`: indicadores técnicos públicos de visualización.
- `data/crypto-reca-state.json`: fuente de verdad de estado operativo.
- `sw.js`: actualización/offline.
- `manifest.webmanifest`: instalación PWA.
- `docs/`: documentación y handoff.
- `.github/workflows/deploy-pages.yml`: despliegue a GitHub Pages.

## Regla de cambios

Para cambios funcionales relevantes: crear rama, probar, revisar y solo después fusionar a `main`. Los cambios de datos producidos por el radar pueden actualizar `data/crypto-reca-state.json` directamente si preservan el contrato de datos.

Antes de trabajar con otra IA, leer `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md` y `CHANGELOG.md`.
