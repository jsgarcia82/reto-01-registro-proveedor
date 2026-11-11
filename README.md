# Reto 01 · Agente conversacional "Registro como Proveedor"

[![CI](https://github.com/jsgarcia82/reto-01-registro-proveedor/actions/workflows/ci.yml/badge.svg)](https://github.com/jsgarcia82/reto-01-registro-proveedor/actions/workflows/ci.yml)

Agente en TypeScript que lee la solicitud del cliente, cruza los campos con el repositorio maestro, **rellena la plantilla** (xlsx/pdf) o prepara los valores del portal, arma el paquete para firma y **solo simula el envío tras una confirmación humana ligada al hash del paquete, su versión y la identidad de quien confirma**.

> Planteamiento completo, decisiones, costos y riesgos: [`SOLUCION.md`](SOLUCION.md) · Decisión de arquitectura: [`docs/ADR-001.md`](docs/ADR-001.md) · Autoauditoría: [`SELF_AUDIT.md`](SELF_AUDIT.md)

| | |
|---|---|
| **Link de prueba** | **https://reto01-registro-proveedor-jwpo.onrender.com** (Render Free: si estuvo inactivo 15 min, la primera carga tarda ~1 min) |
| **Acceso al link** | Usuario y clave se entregan en la defensa (variable `DEMO_USERS` del servidor; no se publican en el repo). |
| **Pruebas** | `npm test`: 61 pruebas, sin clave de API, incluidas `anti_error_1_1` … `anti_error_1_6` |
| **CI** | GitHub Actions: PGlite (sin Docker ni clave) + Postgres 16 real |

## Arranque rápido

Requisitos: Node 20+ (o Docker).

```bash
npm ci
npm run demo     # ejecuta las herramientas sobre los 4 casos SIN modelo (demo.ts)
npm test         # 61 pruebas, sin clave de API
npm run dev      # front + API en http://localhost:3000 (LLM simulado si no hay clave)
```

Al arrancar sin `DEMO_USERS`, el servidor **genera una clave aleatoria** para `analista@local` y la imprime en la consola. Sin `DATABASE_URL` usa **PGlite** (Postgres embebido en `.pgdata/`).

Con Docker (Postgres 16 real), un comando:

```bash
docker compose up --build        # http://localhost:3000
```

Con el modelo real: copia `.env.example` a `.env` y define `ANTHROPIC_API_KEY` (y opcionalmente `ANTHROPIC_MODEL`); `npm run dev` lo lee al arrancar (las variables del entorno tienen prioridad). La clave solo vive en el entorno del backend.

### Prompt de demostración (PRD §11)

1. Pulsa el botón **Procesa ec-corp-andina** (o escribe el prompt del PRD).
2. El chat muestra las 4 llamadas a herramientas (nombre, argumentos, resultado), el resumen y una pregunta final.
3. Escribe **envía**. Aparece un recuadro **resaltado** con la versión, el hash y los bloqueos. **Nada se envía** hasta pulsar *Confirmar envío*.
4. Al confirmar se escribe solo `out/ec-corp-andina/ENVIO-SIMULADO.md`. Reutilizar la confirmación se rechaza.

## Variables de entorno (`.env.example`)

| Variable | Uso | Por defecto |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` o `mock` (simulado determinista) | `anthropic` si hay clave, si no `mock` |
| `ANTHROPIC_API_KEY` | Clave del proveedor (solo backend) | — |
| `ANTHROPIC_MODEL` | Modelo configurable | `claude-sonnet-5-5` |
| `LLM_TIMEOUT_MS` | Timeout al proveedor | `30000` |
| `MAX_ITERATIONS_PER_TURN` | Tope herramienta→modelo por turno (CA1) | `25` |
| `MAX_TOKENS_PER_SESSION` | Tope de tokens por sesión (costo) | `200000` |
| `DATABASE_URL` | Postgres; vacío = PGlite embebido | — |
| `DEMO_USERS` | `correo:clave[,correo:clave]` | clave aleatoria para `analista@local` |
| `AS_OF_DATE` | Fecha de referencia de vigencias (YYYY-MM-DD) | fecha actual |
| `CONFIRMATION_TTL_SECONDS` | Vida del token de confirmación | `600` |
| `COOKIE_SECURE` | `true` detrás de HTTPS | `false` |

## Arquitectura

```
web/ (chat HTML+JS) ──HTTP──▶ src/server.ts (Fastify, auth por cookie httpOnly)
                                 │
                                 ├─ src/agent/loop.ts      ciclo: prompt → LLM → herramientas → respuesta (topes)
                                 │     └─ src/llm/          adapter.ts (interfaz) · anthropic.ts · mock.ts · privacy-guard.ts
                                 ├─ src/tools/proveedor.ts  5 herramientas zod → {ok,data}|{ok:false,error}, nunca lanzan
                                 ├─ src/services/           runs (máquina de estados CAS) · confirmations (HITL) · audit · users
                                 ├─ src/domain/             mapeo, vigencias, privacidad, fixtures (solo lectura)
                                 ├─ src/docs/               xlsx (exceljs) · pdf (pdf-lib, AcroForm) — cargar y rellenar
                                 └─ Postgres / PGlite       FK a users, UNIQUE, transacciones
agent/prompt.md            comportamiento (system prompt)
src/knowledge/*.md         conocimiento del proceso
fixtures/ (solo lectura)   + CHECKSUMS.sha256        out/ (generado)
```

**El LLM solo interpreta, orquesta y redacta.** Mapeo, vigencias, generación de documentos, tokens, compare-and-set, idempotencia, autorización y auditoría son código determinista y probado.

### API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/health` | `{ ok, provider, model }` (público, sin claves) |
| — | (todas) | Límite de tasa por IP: 120/min global, 10/min en login |
| `POST` | `/api/login` · `/api/logout` | Sesión por cookie httpOnly, SameSite=Strict |
| `GET` | `/api/me` | Usuario, casos, fecha de referencia |
| `POST` | `/api/sessions` | Nueva sesión de chat (propia) |
| `GET` | `/api/sessions` · `/api/sessions/:id` | Historial completo; una sesión ajena responde 404 |
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, error }` |
| `POST` | `/api/confirmaciones` | `{ token }` → única vía para ejecutar el envío simulado |
| `GET` | `/api/alertas` | Alertas del usuario (bloqueos, rechazos, envíos con bloqueos) |
| `GET` | `/api/archivos/:caso/*` | Descarga de salidas del caso propio |

### Máquina de estados del caso

`leido → mapeado → formulario_generado → paquete_armado → confirmacion_pendiente → enviado`

Cada transición es `UPDATE … WHERE id AND user_id AND version = esperada AND state IN (…)`. Rearmar el paquete sube la versión e **invalida** el token pendiente.

## Matriz error → control → prueba

| # | Error a evitar | Control | Prueba |
|---|---|---|---|
| 1 | Confirmación no ligada a hash/versión | Token aleatorio (se guarda solo su SHA-256) ligado a `payload_hash`, `run_version`, `user_id`, `session_id` y `expires_at`; se verifica además el hash de los archivos en disco | `tests/anti_error_1_1.test.ts` (9 casos: identidad, versión, archivo alterado, expiración, RN4, reemplazo) |
| 2 | Confirmación no atómica | Consumo `UPDATE … WHERE consumed_at IS NULL` + `SELECT … FOR UPDATE` + CAS de versión + `INSERT` idempotente, todo en **una** transacción | `tests/anti_error_1_2.test.ts` (5 confirmaciones simultáneas → 1 gana; rollback total) |
| 3 | SQL sin FK a usuarios | `user_id NOT NULL REFERENCES users(id)` en las 8 tablas de negocio | `tests/anti_error_1_3.test.ts` (inspección de `information_schema` + inserciones rechazadas) |
| 4 | Carreras entre sesiones | Bloqueo optimista por `version`; `UNIQUE(caso)` para un solo dueño; lease de sesión persistido (`busy_until`) | `tests/anti_error_1_4.test.ts` (CAS, herramientas concurrentes, 2 usuarios, mismo chat) |
| 5 | PDF/XLSX no preservan la plantilla | Se **carga** la plantilla (original del cliente si existe) y se escriben solo las celdas/campos de valor; validación previa de etiquetas | `tests/anti_error_1_5.test.ts` (comparación celda a celda y de campos AcroForm, con plantilla original con estilos) |
| 6 | Datos bancarios llegan al LLM | Vistas minimizadas (`[PROTEGIDO:banco.*]`) + `PrivacyGuardAdapter` sobre todo lo que sale | `tests/anti_error_1_6.test.ts` (espía en el cliente Anthropic: 0 apariciones de cuenta, SWIFT y cédula) |
| + | Idempotencia en memoria | `envios.idempotency_key UNIQUE` en la BD | `tests/idempotencia.test.ts` |
| + | Fixtures alterados / datos inventados | `CHECKSUMS.sha256` verificado en arranque, pruebas y CI; faltante = vacío | `tests/funcional.test.ts` |

## Matriz de cumplimiento (gobierno de IA)

Principios tomados de los materiales de referencia: *Gobernanza y Compliance de IA* (EU AI Act, NIST AI RMF), *AI Fundamentals, Risk & Governance* y el webinar SoundHound/HBR sobre agentes con humano disponible.

| Principio | Cómo se cumple | Evidencia |
|---|---|---|
| **Supervisión humana** proporcional al riesgo | El modelo no puede ejecutar efectos externos: el envío exige un clic humano ligado al paquete exacto; bloqueos visibles antes de confirmar; firma y portal fuera del sistema | `confirmations.ts`, `anti_error_1_1`, e2e |
| **Minimización de datos** | El LLM recibe marcadores en lugar de cuenta, SWIFT y cédula; guarda de texto libre; el borrador de correo nunca lleva datos bancarios (RN2) | `privacy.ts`, `privacy-guard.ts`, `anti_error_1_6` |
| **Trazabilidad / registro** | Quién hizo qué y cuándo: `audit_log`, `out/log.jsonl`, `out/<caso>/log.jsonl`, historial completo por sesión, `ENVIO-SIMULADO.md` con hash y versión | `audit.ts`, `funcional.test.ts` (RN5) |
| **Gestión de riesgos** (mapear, medir, gestionar) | Riesgos del PRD mapeados a controles y pruebas (matriz anterior); topes de iteraciones y tokens; timeouts; alertas persistidas | `loop.ts`, `e2e.test.ts` |
| **Robustez y seguridad** | Validación zod en cada frontera, sesiones privadas, sin trazas crudas, rutas sin traversal, secretos solo en el entorno | `server.ts`, `e2e.test.ts` |
| **Transparencia** | El chat muestra cada herramienta con argumentos y resultado; `requiere_confirmacion` con motivo; `listo_para_firma` con bloqueos | `web/app.js` |

## Supuestos (resumen; detalle en `SOLUCION.md`)

- **Fecha de referencia:** al 2026-11-10 la Cámara de Comercio (vence 2026-09-30) y parafiscales (2026-08-31) están vencidos, así que **todos los casos quedan bloqueados**. La demo muestra además el escenario "a la fecha de cada solicitud". `AS_OF_DATE` la fija.
- **Plantillas binarias ausentes:** los fixtures citan `Formato_Proveedores_v3.xlsx`, `Registro_Proveedor_Extranjero.xlsx` y `Formulario_Calificacion_2026.pdf`, pero no los incluyen. Si están en la carpeta del caso, se cargan y rellenan. Si no, la plantilla base se deriva de `plantilla-celdas.json`/`plantilla-campos.json`, se guarda como `plantilla-base.*` y la salida se compara contra ella.
- **Envío con bloqueos:** se permite solo si el humano confirma viendo los bloqueos (el PRD §11 espera envío en `ec-corp-andina`, que siempre está bloqueado). Queda registrado y genera alerta crítica.
- **Multiusuario:** el PRD no lo exige, pero se implementa para cumplir identidad en la confirmación y sesiones no públicas.

## Lo no cubierto

- Streaming de respuestas (opcional en el PRD).
- PDF de cliente sin AcroForm (se rellenaría por coordenadas); hoy se exige AcroForm o se deriva la plantilla.

## Bonus: módulo reutilizable (`modulo/`)

| Pieza | Origen (sin copias divergentes) |
|---|---|
| `modulo/agent.md` | frontmatter (`mode: primary`, `permission: {edit: deny, bash: deny}`) + `agent/prompt.md` |
| `modulo/tools/proveedor.ts` | re-export de `src/tools/proveedor.ts` + `crearContextoLocal()` para usarlas sin servidor |
| `modulo/skill/registro-proveedor/SKILL.md` | frontmatter + `src/knowledge/registro-proveedor.md` |

Se regenera con `npx tsx scripts/build-modulo.ts`; `tests/modulo.test.ts` falla si divergen.

## Despliegue

Desplegado en **https://reto01-registro-proveedor-jwpo.onrender.com** con `render.yaml` (Blueprint): servicio Docker + Postgres gestionado; `ANTHROPIC_API_KEY` y `DEMO_USERS` se cargan en el panel de Render (no en el repo). Cada push a `main` redespliega.

En el plan Free el disco es efímero: al dormirse el servicio se borra `out/` (la BD se conserva); el agente lo detecta y pide reprocesar el caso antes de enviar.

## Estructura

```
agent/prompt.md · src/{server.ts, agent/, llm/, tools/, services/, domain/, docs/, db/, knowledge/}
web/ · tests/ · demo.ts · modulo/ · fixtures/ (no modificar) · docs/ADR-001.md · SOLUCION.md · SELF_AUDIT.md
```
