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
9. Precios/gráficos: endpoints públicos de Coinbase cuando responden desde el navegador.
10. Motor de análisis: Crypto Reca v3.0, ejecutado fuera del navegador.

## B. Qué se necesita para reconstruir desde cero

- Una cuenta de GitHub.
- Un repositorio, preferiblemente público si se usa GitHub Pages gratuito bajo esta arquitectura.
- Los archivos descritos en este documento.
- GitHub Pages configurado con **Source = GitHub Actions**.
- Un navegador moderno Android/desktop.
- Para sincronización automática desde ChatGPT: conexión GitHub autorizada al repositorio y una tarea horaria de Crypto Reca configurada para actualizar el JSON.

No hacen falta claves de Coinbase para la versión pública/read-only.

## C. Estructura mínima del repositorio

```text
/
  index.html
  app.js
  styles.css
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

## D. Creación de GitHub Pages desde cero

1. Crear el repositorio.
2. Subir los archivos de la aplicación a la rama `main`.
3. Crear `.github/workflows/deploy-pages.yml` con permisos `contents: read`, `pages: write` e `id-token: write`.
4. En GitHub abrir **Settings > Pages**.
5. En **Build and deployment > Source**, elegir **GitHub Actions**.
6. Hacer un commit a `main` para disparar el workflow.
7. Esperar a que GitHub Pages publique la URL.
8. Verificar que `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, iconos y JSON cargan correctamente.

## E. Instalación Android

1. Abrir la URL de producción en Chrome.
2. Esperar a que cargue por HTTPS.
3. Menú de Chrome `⋮`.
4. Elegir **Instalar aplicación** o **Añadir a pantalla de inicio**.
5. Confirmar.
6. Abrir Crypto Reca desde el icono instalado.

Si tras una actualización se ve una versión antigua, cerrar completamente la PWA y volver a abrir. Si persiste, abrir la URL en Chrome y recargar. La estrategia de cache se controla en `sw.js`.

## F. Arquitectura de datos

La app no debe tener scores ni operaciones incrustadas en el código. Todos los datos operativos deben vivir en `data/crypto-reca-state.json`.

`app.js` hace dos cosas diferentes:

1. Lee el último estado de Crypto Reca desde el JSON.
2. Intenta enriquecer la pantalla con precios y velas públicos de Coinbase.

Esta separación es crítica: cambiar un score o registrar una operación no exige editar JavaScript.

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
GitHub Pages despliega
        ↓
la PWA relee el JSON
```

Reglas:

- Nunca reconstruir scores pasados con hindsight.
- Si falta un scan, registrarlo como missing en la auditoría; no inventarlo.
- Si GitHub no está disponible, no abortar el scan.
- No modificar `positions` o `ledger` por inferencia.
- Un fill real requiere confirmación contemporánea del usuario.

## H. Precios en vivo

El frontend intenta consultar endpoints públicos de Coinbase para cada activo. Esta función:

- no requiere login;
- no ve saldo ni órdenes;
- puede fallar por CORS, indisponibilidad, cambios de endpoint o ausencia de un par concreto;
- no debe utilizarse como prueba de fill.

Si falla, la UI debe mostrar `—` en vez de inventar valores.

## I. Integración futura con Coinbase privado

No conectar Coinbase privado directamente desde `app.js`.

Arquitectura segura futura:

```text
PWA pública
  ↓ HTTPS
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

## J. Proceso correcto para mejorar la app

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

## K. Versionado

Hay dos versiones distintas:

- **Crypto Reca v3.0**: versión del motor/reglas de análisis.
- **App 0.3.0**: versión del software visual.

No mezclarlas.

Para cambios de app:

- patch: corrección sin cambio estructural (`0.3.0 -> 0.3.1`);
- minor: nueva funcionalidad compatible (`0.3 -> 0.4`);
- major: rediseño incompatible (`0.x -> 1.0`).

Al cambiar assets estáticos relevantes, actualizar también la constante `CACHE` de `sw.js`.

## L. Backups y recuperación

Git ya conserva el historial de commits. Además:

- conservar documentación dentro del repositorio;
- no borrar ramas/commits necesarios para auditoría sin motivo;
- exportar periódicamente una copia del repositorio si se desea independencia de GitHub;
- el JSON contiene estado operativo, pero no debe ser la única evidencia contable de un fill real: Coinbase sigue siendo la verdad de ejecución.

## M. Riesgos conocidos

1. Repositorio y Pages son públicos.
2. El frontend no autentica al usuario.
3. Mercado público puede fallar temporalmente.
4. El radar depende de que la tarea de ChatGPT siga activa y pueda escribir en GitHub.
5. Un commit defectuoso en `main` puede afectar producción.
6. El service worker puede mantener assets antiguos si no se versiona correctamente.
7. GitHub no es una base de datos transaccional; sirve para esta fase, no para una plataforma de trading de alta frecuencia.

## N. Cuándo migrar fuera de GitHub JSON

Migrar a base de datos/backend cuando ocurra cualquiera de estos casos:

- varias escrituras por minuto;
- múltiples usuarios;
- autenticación;
- datos privados;
- integración de cuenta Coinbase;
- notificaciones push avanzadas;
- órdenes automáticas;
- necesidad de consistencia transaccional.

## O. Prompt estándar de mantenimiento

```text
Trabaja sobre mi aplicación Crypto Reca Dashboard en el repositorio Tresviulk/crypto-reca-dashboard. Antes de modificar nada, lee README.md, docs/AI_HANDOFF.md, docs/CRYPTO_RECA_APP_MASTER_GUIDE.md, docs/DATA_CONTRACT.md y CHANGELOG.md y revisa el código actual. No reconstruyas la app desde cero. No cambies nada no solicitado. Para cambios funcionales, crea una rama, valida el cambio y explícame el impacto antes de llevarlo a main. Mantén secretos fuera del frontend. Cambio solicitado: [AQUÍ LA ORDEN].
```

## P. Criterio de éxito

Una reconstrucción se considera correcta solo si:

- la URL carga por HTTPS;
- la PWA se puede instalar;
- el JSON se lee sin datos inventados;
- el radar puede sincronizarse;
- precios públicos fallan de forma segura;
- el ledger conserva solo operaciones confirmadas;
- no existe ninguna credencial en el repositorio;
- la documentación permite a otra IA continuar sin contexto previo.
