# CRYPTO RECA APP — MASTER GUIDE v0.4.5

## A. Objetivo

Documento de continuidad, reconstrucción, operación y mantenimiento de Crypto Reca Dashboard sin depender de un chat concreto.

- Repo: `Tresviulk/crypto-reca-dashboard`
- Producción: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Producción branch: `main`
- Motor analítico: **Crypto Reca v3.0**
- App objetivo: **0.4.5**
- ERS rulebook: `docs/ENGINE_SPEC_V3_ERS.md` R1
- Hosting: GitHub Pages / GitHub Actions
- Tipo: PWA estática read-only, instalable en Android

## B. Principios de diseño

1. Coinbase Advanced es la verdad de ejecución real.
2. La app nunca convierte recomendación en fill.
3. `PROTECTED` requiere evidencia real de protección; un stop recomendado es solo modelado.
4. ERS/Entry/D/E históricos no se reconstruyen con hindsight.
5. Datos públicos LIVE no pueden reescribir decisiones SCAN ya congeladas.
6. News, gurús y correlación son contexto, no disparadores independientes de ejecución.
7. Secretos y credenciales nunca viven en GitHub/frontend.
8. Cada writer operativo escribe únicamente su archivo modular.

## C. Estructura principal

```text
/
  index.html
  app.js
  radar-time.js
  features-v04.js
  live-indicators-v04.js
  trend-v04.js
  position-risk-v04.js
  news-v04.js
  ers-display-v04.js
  module-loader-v04.js
  decision-v04.js
  risk-tools-v04.js
  research-v04.js
  styles.css
  features-v04.css
  news-v04.css
  trend-v04.css
  architecture-v04.css
  sw.js
  manifest.webmanifest
  README.md
  CHANGELOG.md
  /icons
  /data
    crypto-reca-state.json       # legacy compatibility during migration
    radar-state.json             # Radar authority
    positions-state.json         # confirmed real activity authority
    position-risk.json           # PRS authority
    intelligence.json            # News/Catalysts authority
    external-signals.json        # Guru/external-signal authority
  /docs
    AI_HANDOFF.md
    CRYPTO_RECA_APP_MASTER_GUIDE.md
    DATA_CONTRACT.md
    ENGINE_SPEC_V3_ERS.md
  /.github/workflows
    deploy-pages.yml
```

## D. Arquitectura de datos

### D1. Separación de writers

El antiguo diseño con múltiples procesos escribiendo `data/crypto-reca-state.json` generaba riesgo de lost updates. v0.4.5 lo sustituye por archivos de autoridad aislada:

- **Radar** → `radar-state.json`
- **Actividad real confirmada** → `positions-state.json`
- **Position Risk** → `position-risk.json`
- **News/Catalysts** → `intelligence.json`
- **External Signals/Gurús** → `external-signals.json`

Un writer nunca modifica el archivo de otro módulo.

### D2. Migración segura

Mientras se completa la migración, la PWA:

1. lee `crypto-reca-state.json` como fallback legacy;
2. intenta leer los cinco archivos modulares;
3. superpone solo contenido modular no vacío;
4. conserva datos legacy confirmados si un módulo todavía está vacío o no disponible.

Tras migrar todos los writers, el legacy queda solo como compatibilidad/read-only y deja de recibir escrituras rutinarias.

### D3. Clases de verdad

- **SCAN**: ERS, P/M, D/E, Entry Engine, decisión, trigger, structure.
- **LIVE/CALCULATED**: precios e indicadores públicos del navegador.
- **CONFIRMED COINBASE**: fills, fees, qty, status, actual protection.
- **RISK MODEL**: PRS y pérdida modelada, advisory.
- **INTELLIGENCE**: News/Catalysts y External Signals.

## E. ERS Engine R1

La definición completa está en `docs/ENGINE_SPEC_V3_ERS.md` y prevalece sobre resúmenes antiguos.

### D state

- `D0 DEFENSIVE`: 1D/4H contradicen materialmente una nueva tesis long.
- `D1 TRANSITIONAL`: estructura mixta/rango/transición.
- `D2 CONSTRUCTIVE`: 1D/4H no bajistas y al menos uno claramente constructivo.

### E state

- `E0 CLEAR`: hard/non-score gates aplicables actualmente satisfechos.
- `E1 WATCH`: sin bloqueo fatal, pero falta timing/trigger/location/RR/confirmation ejecutable.
- `E2 BLOCKED`: bloqueo duro (core data, D0, invalidation inexistente, RR insuficiente, stale/invalid, critical event, risk/exposure cap, Preview mismatch/expiry, etc.).

### ERS

Se calculan **dos scores independientes**:

- Pullback / Structure: régimen20, estructura/location20, confirmation/momentum15, volume10, market alignment10, derivatives10, news5, net RR10.
- Momentum / Breakout: HTF trend20, breakout structure20, 1H/4H momentum15, 15m confirmation10, volume10, breadth/relative strength10, derivatives5, news5, net RR5.

`ERS = max(Pullback, Momentum)`; conservar P, M y `ersLane`.

Si 1D/4H/1H core son suficientes, el score debe ser normalmente numérico. Inputs opcionales ausentes reciben tratamiento conservador, no borran todo el score. Si core es insuficiente, `ERS=null` y System Health lo muestra.

ERS no es win probability ni autorización automática.

## F. Entry Engine y tendencia

Entry Engine sigue separado de ERS:

- 0–1/5 NO TIMING
- 2/5 EARLY WATCH
- 3/5 PREPARE
- 4/5 STRONG CONFIRMATION
- 5/5 FULL CONFIRMATION

La tendencia se muestra por 15m / 1H / 4H / 1D. Para CORE, 4H/1D pesan más en tesis; un 1H bajista aislado no equivale automáticamente a tendencia global bajista.

## G. Funcionalidades v0.4.5

### G1. System Health

Presenta estado independiente del Radar, ERS Engine, Position Risk, Intelligence, External Signals y Coinbase público. PASS/PARTIAL/FAIL evita que una capa rota parezca una señal válida.

### G2. Decision Matrix

Por activo presenta conjuntamente, sin promediar:

- ERS
- Entry Engine
- D/E
- tendencia 15m/1H/4H/1D
- PRS/action si hay posición
- News action/impact
- External consensus
- decisión Crypto Reca contemporánea

### G3. Protection Assistant

Para posiciones abiertas muestra invalidación, distancia, pérdida modelada, PRS/thesis y escenarios hipotéticos de reducción 25/50/75%. Es advisory; no crea orden.

### G4. Scenario Lab

Permite introducir un precio hipotético y ver P/L bruto, retorno, distancia a invalidación y si el precio alcanzaría la invalidación. No inventa un ERS/PRS futuro.

### G5. Correlation & Cluster Risk

Calcula correlaciones descriptivas desde series públicas 1H cuando hay muestra suficiente y separa exposición total, BTC+ETH Core y high-beta. Evita presentar varios activos cripto correlacionados como diversificación independiente.

### G6. Gurús / External Signals

Solo llamadas públicas, forward-captured, spot-long compatibles y concretas. Las fuentes permanecen VALIDATING hasta cumplir los criterios definidos por Intelligence Watch. Popularidad o win-rate auto-reportado no sirven de validación.

### G7. Shadow Portfolio

Congela prospectivamente setups PREPARE/rechazados relevantes para estudiar leakage/overfiltering. Variables originales son inmutables; solo el outcome futuro puede actualizarse con price path verificable. Ambiguous permanece ambiguous.

### G8. Funciones anteriores conservadas

- Radar + frescura
- asset detail
- Opportunity Center
- Risk Dashboard
- alerts
- journal
- analytics descriptiva
- timeline
- histórico ERS/Entry
- indicators públicos display-only
- News & Catalysts
- Position Risk/Exit Advisory

## H. Posiciones reales y ledger

`positions-state.json` es la autoridad modular para real activity.

Requisitos:

- fill confirmado antes de añadir posición;
- salida confirmada antes de cerrar;
- fee exacta solo si disponible/confirmada;
- actual stop/protection solo con evidencia;
- ledger append-only normalmente;
- correcciones dejan nota/audit trail.

PRS, News, external signals o un trigger de Radar nunca pueden marcar una venta como ejecutada.

## I. Writers automáticos

### I1. Radar

Cada hora:

1. aplica el ERS spec R1;
2. calcula scan contemporáneo;
3. lee `radar-state.json` actual;
4. actualiza scan/radar/history/audits/engineHealth y Shadow Portfolio autorizado;
5. escribe solo ese archivo;
6. falla de sync sin alterar el análisis.

### I2. Position Risk

Lee posiciones confirmadas y contexto actual; escribe solo `position-risk.json`. Mantiene PRS, trendTimeframes, thesis/action y riskHistory. Nunca ejecuta ni cierra posiciones.

### I3. Intelligence Watch

En una misma tarea para ahorrar slots, mantiene dos outputs separados:

- News/Catalysts → `intelligence.json`
- External Signals/Gurús → `external-signals.json`

No toca Radar, Positions o Risk.

## J. PWA / Android

- HTTPS GitHub Pages.
- Chrome Android → menú → Instalar aplicación / Añadir a pantalla de inicio.
- `sw.js` cachea shell y usa network-first para todos los `data/*.json` con fallback offline.
- Al cambiar assets estáticos, bump de `CACHE`.

## K. Deployment correcto

Para cambios funcionales:

1. revisar main y docs;
2. rama separada;
3. cambios limitados al alcance;
4. validar sintaxis/load order/data safety;
5. comparar con main;
6. actualizar docs/changelog;
7. PR;
8. revisar mergeability/diff;
9. merge solo si seguro;
10. comprobar Pages/producción.

Nunca sobreescribir un JSON operativo fresco con un snapshot viejo de una rama feature.

## L. Rollback

Si código rompe producción:

- revertir código/merge al último commit bueno;
- conservar datos operativos más recientes;
- no force-reset ledger/confirmed positions;
- redeploy y comprobar.

## M. Seguridad y privacidad

El repositorio y Pages son públicos. No almacenar:

- private key
- API secret
- JWT
- password
- cookie/session
- recovery code
- credenciales privadas X/Telegram/Coinbase

Balances privados, órdenes autenticadas, account fills automáticos y ejecución requieren backend privado/serverless con autenticación y secret manager. Empezar read-only si se añade Coinbase privado.

## N. Cuándo dejar GitHub JSON

Migrar a base de datos/backend si aparecen varias escrituras por minuto, varios usuarios, auth, datos privados, trading automático, consistencia transaccional o push avanzado.

## O. Criterios de validación

Una versión se considera apta solo si:

- JS sin errores de sintaxis;
- scripts cargan en orden;
- módulos vacíos no borran legacy durante migración;
- escritores están aislados por archivo;
- ERS missing no parece score 0;
- System Health refleja fallos reales;
- real positions/ledger siguen confirmados únicamente;
- service worker incluye assets nuevos;
- no hay secretos;
- branch no sobreescribe el legacy operativo de main;
- PR es revisable/mergeable;
- Pages carga después de merge.

## P. Prompt estándar

> Trabaja sobre `Tresviulk/crypto-reca-dashboard`. Lee `README.md`, `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md`, `docs/ENGINE_SPEC_V3_ERS.md` y `CHANGELOG.md`, y revisa el código actual antes de cambiar nada. Respeta writers modulares, no reconstruyas datos con hindsight, mantén separados SCAN/LIVE/CONFIRMED/RISK/INTELLIGENCE, usa rama para cambios funcionales y no introduzcas secretos. Cambio solicitado: [DESCRIBIR].
