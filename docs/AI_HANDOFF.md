# AI HANDOFF — Crypto Reca Dashboard

## 1. Identidad

- Repositorio: `Tresviulk/crypto-reca-dashboard`
- Producción: `https://tresviulk.github.io/crypto-reca-dashboard/`
- Rama producción: `main`
- Motor: **Crypto Reca v3.0**
- App objetivo: **0.5.0**
- ERS spec canónica: `docs/ENGINE_SPEC_V3_ERS.md` revision R1
- Position Risk spec canónica: `docs/POSITION_RISK_SPEC_V2_2.md` revision 2.2

## 2. Lectura obligatoria antes de tocar nada

1. `README.md`
2. este archivo
3. `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`
4. `docs/DATA_CONTRACT.md`
5. `docs/ENGINE_SPEC_V3_ERS.md`
6. `docs/POSITION_RISK_SPEC_V2_2.md`
7. `CHANGELOG.md`
8. código actual de la rama objetivo

No reconstruir desde memoria, capturas o chats antiguos.

## 3. Reglas de preservación

- No inventar precios, scores, timestamps, fills, órdenes o protección.
- No transformar recomendación en ejecución.
- No reconstruir ERS/Entry/stop/TP históricos con hindsight.
- No cambiar una regla de ERS/D/E/Position Risk silenciosamente: cualquier cambio requiere spec + data contract + changelog + writer.
- No almacenar claves, JWT, cookies, passwords o secrets en frontend/GitHub.
- Cambio funcional importante: rama → validar → PR → merge main → verificar Pages.
- El repositorio/Pages es público.

## 4. Arquitectura de datos modular v2

`data/crypto-reca-state.json` es **compatibilidad legacy durante migración**, no la superficie normal de múltiples escritores.

Autoridades:

- `data/radar-state.json` — solo Radar: scan, P/M/ERS, D/E, Entry, history, audits, ERS health, Shadow Portfolio.
- `data/positions-state.json` — solo evidencia CONFIRMED COINBASE: positions, ledger, actual protection, journal confirmado.
- `data/position-risk.json` — solo Position Risk: PRS + riskHistory.
- `data/intelligence.json` — solo News/Catalysts.
- `data/external-signals.json` — solo External Signals / guru validation.

**Un writer nunca debe escribir en el archivo de otro módulo.**

Durante migración, la PWA carga primero el legacy y luego superpone módulos no vacíos. Un placeholder vacío no puede borrar datos confirmados.

## 5. ERS repair R1

La fuente canónica es `docs/ENGINE_SPEC_V3_ERS.md`.

Resumen:

- D0 DEFENSIVE, D1 TRANSITIONAL, D2 CONSTRUCTIVE.
- E0 CLEAR, E1 WATCH, E2 BLOCKED.
- Pullback y Momentum se puntúan por separado a 100.
- `ERS = max(Pullback, Momentum)` y se conserva `ersLane`.
- Datos core 1D/4H/1H suficientes → normalmente score numérico.
- Input opcional ausente → penalización/0 conservador; no desaparecer todo el score.
- Core insuficiente → `ERS=null` + System Health PARTIAL/FAIL.
- La UI debe mostrar `ERS NO CALCULADO`, nunca 0/stale como sustituto.

ERS no es probabilidad de beneficio ni autorización de trade.

## 6. Position Risk v2.2 — thesis validity vs exit urgency

La fuente canónica es `docs/POSITION_RISK_SPEC_V2_2.md`. Conserva las reglas breach/reclaim de v2.1 y corrige la urgencia de salida.

Reglas críticas:

- un mínimo intrabar bajo la invalidación técnica = `BREACH`, no invalidación permanente automática;
- invalidación confirmada requiere 2 cierres 15m consecutivos bajo el nivel, o 1 cierre 1H bajo el nivel, o tocar el catastrophic boundary previamente definido, o una discontinuidad de mercado documentada;
- si antes de confirmarse la invalidación una vela 15m completada cierra de nuevo en/por encima del nivel, el estado pasa a `RECLAIMED`;
- una invalidación confirmada permanece registrada como `INVALIDATED`; una recuperación posterior no reescribe el setup original;
- **`INVALIDATED` ya no fuerza por sí solo `EXIT SIGNAL` para siempre**;
- action se obtiene del PRS actual: 0–24 HOLD, 25–44 WATCH, 45–59 REDUCE REVIEW, 60–79 EXIT REVIEW, 80–100 EXIT SIGNAL;
- una posición `INVALIDATED` tiene suelo operativo `EXIT REVIEW` mientras siga abierta bajo ese setup original;
- `EXIT SIGNAL` / tratamiento rojo crítico solo se usa con PRS >=80, catastrophic-boundary touch o discontinuidad/ejecución de emergencia documentada;
- recuperación de precio/régimen/momentum puede bajar B/C/D y convertir `EXIT SIGNAL` en `EXIT REVIEW` sin borrar A=40 ni la invalidación histórica;
- el catastrophic boundary nunca puede inventarse retroactivamente.

## 7. Capas que no deben mezclarse

- **SCAN**: ERS, D/E, Entry Engine, decision, trigger, structure.
- **LIVE/CALCULATED**: Coinbase público e indicadores frontend.
- **CONFIRMED COINBASE**: fills, fees, qty, actual protection.
- **RISK MODEL**: PRS/advisory.
- **INTELLIGENCE**: news/catalysts/external signals.

Decision Matrix las presenta juntas pero nunca las promedia ni permite que una capa externa reescriba otra.

## 8. Funcionalidades v0.5.0

- Radar + timestamp/freshness.
- Full asset detail + ERS/Entry history.
- Opportunity Center.
- Risk Dashboard.
- Position Risk / Exit Advisory.
- Thesis validity separated from current exit urgency.
- Multi-timeframe trend 15m/1H/4H/1D.
- System Health.
- Decision Matrix.
- Protection Assistant.
- Scenario Lab.
- Correlation & Cluster Risk.
- News & Catalysts.
- Gurús / External Signals forward validation.
- Shadow Portfolio prospective/no-hindsight.
- Journal, timeline, descriptive analytics, alerts.

## 9. Real positions

Only `data/positions-state.json` may become the modular source of real fills/protection.

On user-confirmed buy/sell/stop change:

1. verify contemporaneous evidence;
2. fetch latest positions module;
3. modify only the confirmed fields/ledger/journal;
4. preserve previous records;
5. never mark PROTECTED without real evidence;
6. never infer a sale from PRS/news/guru/radar.

Coinbase Advanced remains execution truth.

## 10. Writer rules

### Radar
Read its own latest module before writing. Update only `radar-state.json`. Preserve history/audits/shadow as appropriate. Produce ERS health every run. Never write positions/risk/intelligence/external files.

### Position Risk
Read confirmed open positions from `positions-state.json` and current radar context if useful. Read and obey `docs/POSITION_RISK_SPEC_V2_2.md`. Write only `position-risk.json`. Advisory only. Preserve breach/reclaim/invalidation evidence in `riskHistory`. Never convert an intrabar wick alone into permanent `INVALIDATED`. Never force permanent `EXIT SIGNAL` solely because the thesis was historically invalidated; use current PRS and the v2.2 invalidated-action floor.

### Intelligence Watch
Write News/Catalysts only to `intelligence.json`; External Signals/source validation only to `external-signals.json`. Do not modify fills/radar/risk.

## 11. Shadow Portfolio

Freeze candidates only contemporaneously. Later price path may update outcome, but original entry/ERS/Entry/gate/invalidation/target cannot be rebuilt or edited after the fact. Ambiguity remains ambiguous.

## 12. Frontend modules

Base/legacy-compatible layer:
- `app.js`
- `radar-time.js`
- `features-v04.js`
- `live-indicators-v04.js`
- `trend-v04.js`
- `position-risk-v04.js`
- `news-v04.js`

Hardening layer:
- `ers-display-v04.js`
- `module-loader-v04.js` — modular reads + System Health + single new-screen/action registry `window.CR4`.
- `decision-v04.js`
- `risk-tools-v04.js`
- `research-v04.js`
- `architecture-v04.css`

New hardening modules should use `CR4.registerScreen` / `CR4.on` rather than creating another independent `show()` wrapper.

## 13. Deployment / rollback

Push/merge to `main` deploys through GitHub Pages workflow. On static change, bump service-worker cache. If production breaks, revert code without overwriting newer operational data. Never force-reset confirmed ledger data.

## 14. Security / future backend

No authenticated Coinbase integration in public frontend. Private balances, exact account orders, authenticated fills or automatic execution require private backend/serverless + secret manager + auth, starting read-only where possible.

## 15. Standard prompt for another AI

> Trabaja sobre `Tresviulk/crypto-reca-dashboard`. Antes de modificar nada, lee `README.md`, `docs/AI_HANDOFF.md`, `docs/CRYPTO_RECA_APP_MASTER_GUIDE.md`, `docs/DATA_CONTRACT.md`, `docs/ENGINE_SPEC_V3_ERS.md`, `docs/POSITION_RISK_SPEC_V2_2.md` y `CHANGELOG.md`, y revisa el código actual. No reconstruyas desde memoria. No cambies funcionalidades no solicitadas. Para cambios funcionales usa rama y valida antes de `main`. Respeta los writers modulares: radar, positions, risk, intelligence y external signals nunca escriben en el archivo de otro. Mantén separados SCAN, LIVE/CALCULATED, CONFIRMED COINBASE, RISK MODEL e INTELLIGENCE. No introduzcas secretos. Cambio solicitado: [DESCRIBIR].
