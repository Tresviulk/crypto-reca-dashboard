# CRYPTO RECA APP — MASTER GUIDE

## Objetivo

Este documento permite reconstruir, mantener o migrar Crypto Reca Dashboard desde cero sin depender de una conversación concreta de ChatGPT.

## A. Componentes y propiedad

1. Cuenta GitHub que aloja el proyecto: `Tresviulk`.
2. Repositorio: `crypto-reca-dashboard`.
3. Rama de producción: `main`.
4. URL de producción: `https://tresviulk.github.io/crypto-reca-dashboard/`.
5. Hosting: GitHub Pages.
6. Deployment: GitHub Actions.
7. Tipo de app: PWA web estática, instalable en Android.
8. Fuente de datos de aplicación: `data/crypto-reca-state.json`.
9. Precios/gráficos/indicadores de visualización: endpoints públicos de Coinbase cuando responden desde el navegador.
10. Motor de análisis: Crypto Reca v3.0, ejecutado fuera del navegador.
11. App visual objetivo actual: v0.4.x.

## B. Qué se necesita para reconstruir desde cero

- Una cuenta de GitHub.
- Un repositorio, preferiblemente público si se usa GitHub Pages gratuito bajo esta arquitectura.
- Los archivos descritos en este documento.
- GitHub Pages configurado con **Source = GitHub Actions**.
- Un navegador moderno Android/desktop.
- Para sincronización automática desde ChatGPT: conexión GitHub autorizada al repositorio y una tarea horaria de Crypto Reca configurada para actualizar el JSON.

No hacen falta claves de Coinbase para la versión pública/read-only.

## C. Estructura del repositorio v0.4

```text
/
  index.html
  app.js
  radar-time.js
  features-v04.js
  live-indicators-v04.js
  styles.css
  features-v04.css
  manifest.webmanifest
  sw.js
  README.md
  CHANGELOG.md
  /icons
    icon-192.png
    icon-512.png
  /data
    crypto-reca-state.json
  /docs
    AI_HANDOFF.md
    CRYPTO_RECA_APP_MASTER_GUIDE.md
    DATA_CONTRACT.md
  /.github/workflows
    deploy-pages.yml
```

`app.js` se mantiene como núcleo relativamente pequeño. Las funcionalidades nuevas se separan en módulos para facilitar rollback y evitar reescribir el core estable.

## D. Creación de GitHub Pages desde cero

1. Crear el repositorio.
2. Subir los archivos de la aplicación a la rama `main`.
3. Crear `.github/workflows/deploy-pages.yml` con permisos `contents: read`, `pages: write` e `id-token: write`.
4. En GitHub abrir **Settings > Pages**.
5. En **Build and deployment > Source**, elegir **GitHub Actions**.
6. Hacer un commit a `main` para disparar el workflow.
7. Esperar a que GitHub Pages publique la URL.
8. Verificar que `index.html`, scripts, CSS, manifest, service worker, iconos y JSON cargan correctamente.

## E. Instalación Android

1. Abrir la URL de producción en Chrome.
2. Esperar a que cargue por HTTPS.
3. Menú de Chrome `⋮`.
4. Elegir **Instalar aplicación** o **Añadir a pantalla de inicio**.
5. Confirmar.
6. Abrir Crypto Reca desde el icono instalado.

Si tras una actualización se ve una versión antigua, cerrar completamente la PWA y volver a abrir. Si persiste, abrir la URL en Chrome y recargar. La estrategia de cache se controla en `sw.js`.

## F. Arquitectura de datos

La app no debe tener scores ni operaciones reales incrustadas en el código. Todos los datos operativos deben vivir en `data/crypto-reca-state.json`.

Hay tres categorías visuales que no deben mezclarse:

1. **SCAN**: ERS, D/E, Entry Engine, decisión, triggers o estructura generados por Crypto Reca en el scan contemporáneo.
2. **LIVE / CALCULATED**: precios e indicadores derivados de mercado público por el navegador. Son información visual y no reescriben la decisión del scan.
3. **CONFIRMED COINBASE**: fills, posiciones y protección realmente confirmados por el usuario/ejecución.

Esta separación es crítica.

## G. Sincronización automática del radar

El proceso recomendado es:

```text
Crypto Reca v3.0 Radar (cada hora)
        ↓
calcula scan contemporáneo
        ↓
publica resultado en ChatGPT
        ↓
lee data/crypto-reca-state.json
        ↓
actualiza scan + radar + history
        ↓
commit a main
        ↓
GitHub Pages despliega / JSON queda disponible
        ↓
la PWA relee el JSON automáticamente
```

Reglas:

- Nunca reconstruir scores pasados con hindsight.
- Si falta un scan, registrarlo como missing en la auditoría; no inventarlo.
- Si GitHub no está disponible, no abortar el scan.
- No modificar `positions` o `ledger` por inferencia.
- Un fill real requiere confirmación contemporánea del usuario.

## H. Funcionalidades visuales v0.4

### H1. Radar con frescura

Muestra claramente la hora del último scan Crypto Reca, la hora de sincronización y la hora separada del mercado público. Estados de frescura: actual, retrasado, antiguo o pendiente.

### H2. Ficha completa por activo

Al tocar un activo del Radar se abre una ficha con:

- precio público vivo;
- ERS;
- D/E;
- Entry Engine y sus 5 dimensiones si el scan las aportó;
- decisión del último scan;
- estructura/trigger/invalidation si existe;
- indicadores del scan si existen;
- indicadores públicos de visualización calculados desde velas 1H completadas;
- histórico ERS;
- histórico Entry Engine.

### H3. Centro de oportunidades

Ordena los activos por estado operativo + Entry Engine + ERS. No es probabilidad de beneficio ni autorización de trade.

### H4. Risk Dashboard

Separa:

- exposición abierta;
- riesgo modelado hasta el stop técnico recomendado;
- riesgo realmente protegido cuando existe un stop confirmado.

Nunca contar un stop recomendado como protección real.

### H5. Alertas internas

Detecta dentro de la app condiciones como sincronización retrasada, posición sin protección, PREPARE y STRONG CONFIRMATION. No equivale a push notification externo.

### H6. Journal

Combina acciones Coinbase confirmadas y registros contemporáneos del radar. No crear narrativas retrospectivas.

### H7. Analítica

Calcula métricas descriptivas del histórico disponible (número de scans, ERS medio, PREPARE+, STRONG+). No calcular win rate fiable con muestra insuficiente.

### H8. Timeline

Une eventos confirmados de operación con los scans almacenados para facilitar auditoría de la vida de una posición.

## I. Indicadores públicos de visualización

`live-indicators-v04.js` usa velas públicas completadas de Coinbase para intentar calcular:

- EMA20 / EMA50 / EMA200 en 1H;
- RSI14 1H;
- MACD 12/26 (línea principal para visualización);
- ATR14 1H;
- standard VWAP de las últimas 24 velas 1H;
- RVOL de la última vela completada vs media de las 20 anteriores.

Estos datos son **display-only**. Si no hay historial suficiente, mostrar `—` o muestra insuficiente. Nunca usarlos retrospectivamente para alterar un score ya registrado.

## J. Integración futura con Coinbase privado

No conectar Coinbase privado directamente desde `app.js` ni desde ninguno de los módulos frontend.

Arquitectura segura futura:

```text
PWA
  ↓ HTTPS + autenticación
Backend privado / serverless
  ↓ secret manager
Coinbase API
```

Requisitos mínimos:

- secretos fuera de GitHub;
- API keys con permisos mínimos;
- empezar read-only;
- allowlist/IP controls si Coinbase los ofrece;
- logs de acceso;
- nunca exponer secret o private key al navegador;
- separar consulta de cuenta de ejecución de órdenes.

No habilitar trading automático sin una decisión explícita y un diseño adicional de controles.

## K. Proceso correcto para mejorar la app

### Cambio pequeño de contenido/datos

Si es un dato operativo contemporáneo y respeta `DATA_CONTRACT.md`, actualizar el JSON.

### Cambio funcional

1. Revisar `main` actual.
2. Crear una rama con nombre descriptivo.
3. Cambiar solo lo solicitado.
4. Validar sintaxis y estructura.
5. Revisar diff.
6. Actualizar documentación y `CHANGELOG.md`.
7. Abrir PR o comparar rama con `main`.
8. Hacer merge solo cuando la versión esté validada.
9. Comprobar producción después del deployment.

## L. Versionado

Hay dos versiones distintas:

- **Crypto Reca v3.0**: versión del motor/reglas de análisis.
- **App 0.4.x**: versión del software visual.

No mezclarlas.

Para cambios de app:

- patch: corrección sin cambio estructural (`0.4.0 -> 0.4.1`);
- minor: nueva funcionalidad compatible (`0.4 -> 0.5`);
- major: rediseño incompatible (`0.x -> 1.0`).

Al cambiar assets estáticos relevantes, actualizar también la constante `CACHE` de `sw.js`.

## M. Backups y recuperación

Git conserva el historial de commits. Además:

- conservar documentación dentro del repositorio;
- no borrar ramas/commits necesarios para auditoría sin motivo;
- exportar periódicamente una copia del repositorio si se desea independencia de GitHub;
- el JSON contiene estado operativo, pero Coinbase sigue siendo la verdad de ejecución.

## N. Riesgos conocidos

1. Repositorio y Pages son públicos.
2. El frontend no autentica al usuario.
3. Mercado público puede fallar temporalmente.
4. El radar depende de que la tarea de ChatGPT siga activa y pueda escribir en GitHub.
5. Un commit defectuoso en `main` puede afectar producción.
6. El service worker puede mantener assets antiguos si no se versiona correctamente.
7. GitHub no es una base de datos transaccional; sirve para esta fase, no para una plataforma de trading de alta frecuencia.
8. Los cálculos públicos del frontend son auxiliares, no evidencia de lo que el motor vio en un scan pasado.

## O. Cuándo migrar fuera de GitHub JSON

Migrar a base de datos/backend cuando ocurra cualquiera de estos casos:

- varias escrituras por minuto;
- múltiples usuarios;
- autenticación;
- datos privados;
- integración de cuenta Coinbase;
- notificaciones push avanzadas;
- órdenes automáticas;
- necesidad de consistencia transaccional.

## P. Prompt estándar de mantenimiento

```text
Trabaja sobre mi aplicación Crypto Reca Dashboard en el repositorio Tresviulk/crypto-reca-dashboard. Antes de modificar nada, lee README.md, docs/AI_HANDOFF.md, docs/CRYPTO_RECA_APP_MASTER_GUIDE.md, docs/DATA_CONTRACT.md y CHANGELOG.md y revisa el código actual. No reconstruyas la app desde cero. No cambies nada no solicitado. Para cambios funcionales, crea una rama, valida el cambio y explícame el impacto antes de llevarlo a main. Mantén separados LIVE/CALCULATED, SCAN y CONFIRMED COINBASE. Mantén secretos fuera del frontend. Cambio solicitado: [AQUÍ LA ORDEN].
```

## Q. Criterio de éxito

Una reconstrucción se considera correcta solo si:

- la URL carga por HTTPS;
- la PWA se puede instalar;
- el JSON se lee sin datos inventados;
- el radar puede sincronizarse;
- precios públicos fallan de forma segura;
- el ledger conserva solo operaciones confirmadas;
- el Risk Dashboard no confunde riesgo modelado con protección real;
- la analítica no inventa significancia con muestra pequeña;
- no existe ninguna credencial en el repositorio;
- la documentación permite a otra IA continuar sin contexto previo.
