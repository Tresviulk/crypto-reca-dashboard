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
- Calcula analítica técnica visual desde velas completadas: EMA20/50/200, RSI14, MACD, ATR14, standard VWAP y RVOL.
- Incluye ficha completa por activo, Centro de Oportunidades, Risk Dashboard, alertas internas, journal, analítica e histórico/timeline.
- Incluye Position Risk / Exit Advisory para posiciones abiertas con PRS y acciones HOLD / WATCH / REDUCE REVIEW / EXIT REVIEW / EXIT SIGNAL.
- Separa la tendencia por temporalidad: 15m / 1H / 4H / 1D, evitando que un único indicador bajista se presente como si definiera toda la estructura del mercado.
- Incluye News & Catalysts y un modelo separado de validación forward de señales externas/gurús públicos.
- Funciona como PWA instalable y conserva una copia offline de la interfaz.

## Qué NO hace

- No contiene claves de Coinbase.
- No accede a saldo privado ni órdenes de Coinbase.
- No ejecuta compras, ventas ni stops.
- No sustituye la confirmación de ejecución en Coinbase Advanced.
- No presenta indicadores públicos calculados en el frontend como si fueran los valores contemporáneos usados por el motor de decisión.
- No convierte una noticia o una señal externa en una compra/venta automática.

## Arquitectura

- `index.html`: shell de la PWA.
- `styles.css`: estilos base.
- `features-v04.css`: estilos de la capa funcional v0.4.
- `news-v04.css`: estilos del overlay de noticias/catalizadores.
- `trend-v04.css`: estilos de tendencia multitemporal.
- `app.js`: núcleo estable de lectura de datos, mercado público y UI base.
- `radar-time.js`: fecha/hora y frescura del radar.
- `features-v04.js`: oportunidades, riesgo, ficha por activo, alerts, journal, analytics y timeline.
- `live-indicators-v04.js`: indicadores técnicos públicos de visualización.
- `trend-v04.js`: cálculo visual separado de 15m / 1H / 4H / 1D y conclusión conjunta.
- `position-risk-v04.js`: interfaz del motor de riesgo/salida.
- `news-v04.js`: noticias y catalizadores.
- `data/crypto-reca-state.json`: fuente de verdad de estado operativo.
- `sw.js`: actualización/offline.
- `manifest.webmanifest`: instalación PWA.
- `docs/`: documentación y handoff.
- `.github/workflows/deploy-pages.yml`: despliegue a GitHub Pages.

## Regla de cambios

Para cambios funcionales relevantes: crear rama, probar, revisar y solo después fusionar a `main`. Los cambios de datos producidos por el radar/risk/intelligence writers pueden actualizar `data/crypto-reca-state.json` directamente si preservan el contrato de datos y modifican únicamente sus campos autorizados.

Antes de trabajar con otra IA, leer `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md` y `CHANGELOG.md`.
