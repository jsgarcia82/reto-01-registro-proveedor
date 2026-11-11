# SELF_AUDIT · autoauditoría contra los criterios de éxito

Escala 1–5, sin inflar. Cada nota cita archivo y prueba verificables. Evidencia de ejecución (2026-11-10, clon limpio desde GitHub y CI de GitHub Actions):

- `npm ci && npm run typecheck && npm test`: **64/64** con PGlite y **64/64** contra **Postgres 16 real** (`TEST_DATABASE_URL`).
- `npm run demo`: 4 casos × 2 escenarios de fecha; 0 datos sensibles en 35 salidas de herramientas; fixtures íntegros.

| # | Criterio | Nota | Evidencia | Qué impide el 5 |
|---|---|---|---|---|
| 1 | Cobertura de los errores listados | **5** | `tests/anti_error_1_1` … `anti_error_1_6` (29 pruebas) | — |
| 2 | Integridad y concurrencia | **4.5** | FK en 8 tablas (`anti_error_1_3`); CAS por versión, `UNIQUE(caso)`, lease de sesión (`anti_error_1_4`); transacción única en confirmación (`anti_error_1_2`); idempotencia `UNIQUE` (`idempotencia.test.ts`); validado en Postgres real | Los archivos en `out/` usan escritura atómica (tmp+rename) pero no son transaccionales con la BD ante un crash a mitad de un rename múltiple; se detecta al confirmar (re-hash en disco) |
| 3 | HITL y confirmación ligada a hash, versión e identidad | **5** | `src/services/confirmations.ts`; `anti_error_1_1` (9 casos: identidad, versión, archivo alterado, expiración, RN4, reemplazo, solo hash del token); e2e con 2 usuarios | — |
| 4 | Privacidad y seguridad | **4.5** | Espía en el cliente Anthropic (`anti_error_1_6`); `PrivacyGuardAdapter`; login + cookie httpOnly/SameSite=Strict; sesiones ajenas 404; límite de tasa; zod en todas las fronteras; sin secretos en árbol ni historial | El límite de tasa (por IP real del cliente detrás del proxy de Render, probado) vive en memoria por instancia; en multi-réplica iría a Redis. No hay token CSRF explícito (mitigado con SameSite=Strict y JSON) |
| 5 | Fidelidad al reto | **4.5** | Fixtures intactos con checksum; 4 casos, P0/P1/P2, HU-1..5 y RN1..5 (`funcional.test.ts`); prompt del PRD §11 e2e; bonus `modulo/`; **link público activo** (https://reto01-registro-proveedor-jwpo.onrender.com) | Plantillas binarias no incluidas en los fixtures, así que la base se deriva (declarado; ruta "adjunto original" probada) |
| 6 | Calidad de pruebas y CI | **5** | 61 pruebas sin clave; LLM simulado determinista; pruebas de concurrencia, idempotencia y e2e HTTP; GitHub Actions **en verde** en ambos jobs (PGlite y Postgres 16 real); **modo LLM real verificado en el link** (Anthropic): `ec-corp-andina` → 4 herramientas ok, 13/15 llenos, faltante y RUC por confirmar correctos, datos bancarios protegidos, alertas visibles | — |
| 7 | Gobierno y trazabilidad | **5** | `audit_log` + `out/log.jsonl` + `out/<caso>/log.jsonl` (RN5 probado); alertas persistidas y visibles en la UI; historial completo por sesión; `ENVIO-SIMULADO.md` con quién, versión y hash; matriz de cumplimiento en el README | — |
| 8 | Claridad del README y demo end-to-end | **4.5** | README con un comando, variables, API, matrices y supuestos; `demo.ts` sin modelo; e2e HTTP del flujo real; imagen Docker construida y desplegada por Render | `docker compose up` no ejecutado localmente |

**Promedio: 4.75** (≥ 4.5) · **mínimo: 4** (ningún criterio < 4) · **reproducible desde clon limpio: sí.**

## Lo que no está verificado en este entorno (declarado)

1. `docker compose up`: no ejecutado localmente (sin daemon Docker). El `Dockerfile` sí lo construyó y desplegó Render con Postgres gestionado.
2. Llamada real a la API de Anthropic: el adaptador se probó con un cliente espía que replica el formato del Messages API. Hay que probarlo con `ANTHROPIC_API_KEY` antes de la defensa.
3. Link público: desplegado en Render (Blueprint) con el modelo real; procesamiento verificado en el link por el candidato.
