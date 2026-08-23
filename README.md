# Crypto Reca Dashboard

Aplicación web/PWA de seguimiento de **Crypto Reca v3.0**.

## Producción

- URL: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Repositorio: `Tresviulk/crypto-reca-dashboard`
- Rama de producción: `main`
- Despliegue: GitHub Pages mediante GitHub Actions
- App actual: `0.3.0`

## Qué hace

- Lee el estado operativo desde `data/crypto-reca-state.json`.
- Muestra radar, ERS, D/E, Entry Engine, posiciones, ledger y auditorías.
- Consulta precios y velas públicas de Coinbase cuando están disponibles.
- Calcula P/L no realizado con precio público en vivo.
- Funciona como PWA instalable y conserva una copia offline de la interfaz.

## Qué NO hace

- No contiene claves de Coinbase.
- No accede a saldo privado ni órdenes de Coinbase.
- No ejecuta compras, ventas ni stops.
- No sustituye la confirmación de ejecución en Coinbase Advanced.

## Arquitectura

- `index.html`: shell de la PWA.
- `styles.css`: presentación.
- `app.js`: lectura de datos, mercado público y UI.
- `data/crypto-reca-state.json`: fuente de verdad de la app.
- `sw.js`: actualización/offline.
- `manifest.webmanifest`: instalación PWA.
- `docs/`: documentación y handoff.
- `.github/workflows/deploy-pages.yml`: despliegue a GitHub Pages.

## Regla de cambios

Para cambios funcionales relevantes: crear rama, probar, revisar y solo después fusionar a `main`. Los cambios de datos producidos por el radar pueden actualizar `data/crypto-reca-state.json` directamente si preservan el contrato de datos.

Antes de trabajar con otra IA, leer `docs/AI_HANDOFF.md` y `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`.
