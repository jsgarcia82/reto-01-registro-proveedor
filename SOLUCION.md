# SOLUCIÓN · Reto 01 "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa transcribe a mano, campo por campo y con riesgo de error en datos sensibles (NIT, cuenta bancaria), entre 8 y 12 formularios de registro de proveedor al mes. Le duele a la **analista administrativa**, que pierde a un compañero, y a **facturación**, que espera días por el alta.

## 2. Arquitectura

```
┌─────────────┐  HTTP + cookie  ┌──────────────────────────────────────────────────────────────┐
│ web/        │ ──────────────▶ │ src/server.ts  (Fastify · auth · validación zod)             │
│ chat, tools │ ◀────────────── │   └─ src/agent/loop.ts   ciclo + topes + lease de sesión      │
│ confirmar   │                 │        └─ src/llm/        adapter · anthropic · mock · guard  │
└─────────────┘                 │   └─ src/tools/proveedor.ts  ← ÚNICA fuente de valores         │
                                │        └─ src/services/   runs (CAS) · confirmations · audit  │
                                │        └─ src/domain/     mapeo · vigencias · privacidad      │
                                │        └─ src/docs/       xlsx · pdf (cargar y rellenar)      │
                                └──────┬──────────────────────────┬──────────────────┬──────────┘
                                       │                          │                  │
                         fixtures/ (solo lectura,       out/ (escritura atómica)   Postgres / PGlite
                          CHECKSUMS.sha256)                                         (FK, UNIQUE, tx)
```

| Capa | Dónde vive |
|---|---|
| **Comportamiento** | `agent/prompt.md` |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` |
| **Ejecución** | `src/tools/proveedor.ts` (+ `src/services`, `src/domain`, `src/docs`) |

Un cambio de reglas de negocio toca `src/domain` o `src/knowledge`, nunca `server.ts`.

## 3. Ciclo del agente

- **Bucle** (`src/agent/loop.ts`):
  1. Toma un *lease* de la sesión en la BD (`busy_until`), lo que evita dos turnos simultáneos en el mismo chat.
  2. Guarda el mensaje del usuario y llama al modelo con el historial completo y las 5 herramientas, cuyo JSON Schema se genera desde zod.
  3. Ejecuta cada llamada a herramienta (validación zod; un error vuelve al modelo como `{ok:false,error}`), la persiste en el historial y en `out/log.jsonl`, y repite.
- **Topes:** `MAX_ITERATIONS_PER_TURN` (25) y `MAX_TOKENS_PER_SESSION`. Al alcanzarlos, el agente responde qué hizo y qué falta. Ante timeout o error del proveedor, responde en lenguaje claro y la sesión sigue viva.
- **Confirmación humana (CA3 / RN4):**
  1. `proveedor_simular_envio` nunca envía. Si la persona pidió enviar, el servidor crea un token de un solo uso ligado al `payload_hash` del paquete (hash de cada archivo, bloqueos y fecha de referencia), a la versión del caso, al usuario, a la sesión y a una expiración.
  2. El token viaja **solo** al front, que resalta el recuadro de confirmación. El LLM recibe "requiere confirmación explícita".
  3. Al pulsar *Confirmar*, `POST /api/confirmaciones` hace en una sola transacción: consumo compare-and-set del token, `FOR UPDATE` del caso, verificación de versión y hash (incluido el recálculo de los archivos en disco), `INSERT` con clave de idempotencia `UNIQUE` y escritura de `ENVIO-SIMULADO.md`.
  4. Cualquier mensaje nuevo cancela las confirmaciones pendientes: la confirmación vale solo para el turno inmediato.

## 4. Elección del modelo y costo

- **Proveedor:** Anthropic, con modelo configurable (`ANTHROPIC_MODEL`, por defecto `claude-sonnet-5-5`). Buen tool use y bajo costo para una tarea de orquestación. El trabajo pesado (mapeo, documentos) es determinista, así que no hace falta un modelo de mayor tier. Cambiar de proveedor solo requiere implementar `LlmAdapter`.
- **Consumo medido:** en el flujo del prompt de demostración, el agente hace 5 llamadas al modelo por caso. La suma de prompts medida fue de ~50 000 caracteres (≈ 14 000 tokens de entrada) y la salida ronda ≤ 1 500 tokens.
- **Costo estimado:** con la tarifa publicada de Sonnet 5.5 (USD 2 por millón de tokens de entrada y 10 por millón de salida; fuente: página de precios de Anthropic, `platform.claude.com/docs/en/about-claude/pricing`), sale a **≈ USD 0.03 + 0.015 ≈ USD 0.05 por caso**, más ~USD 0.01 por el turno de envío.
  - Con 12 casos al mes: **< USD 1/mes**.
  - El *prompt caching* del system prompt y de las herramientas lo reduciría aún más.
- **Tope de costo:** límite de tokens por sesión y de iteraciones por turno. Además, el link exige login.

## 5. Diseño del portal web (formato `portal`, §7.4)

- **Hoy:** `generar_formulario` responde `formato no soportado` y escribe `out/<caso>/valores-portal.md` con etiqueta, valor y estado (incluye `requiere_confirmacion`). El paquete y la confirmación funcionan igual.
- **Estrategia propuesta:** un navegador controlado por el agente (Playwright) con un "modo asistido".
  1. El agente abre el portal en un navegador visible.
  2. **El humano ingresa credenciales y resuelve CAPTCHA/MFA.**
  3. El agente solo rellena campos que mapean 1:1 contra `valores-portal.md`, mediante selectores aprendidos y versionados por cliente.
  4. Antes de cada envío toma una captura y la muestra para confirmación ligada al hash, igual que hoy.
  5. **El clic en "Enviar" es humano.**
- **RPA y extensión:** una extensión de navegador que "pegue" los valores es la alternativa de menor riesgo. El RPA tradicional se descarta por fragilidad ante cambios de layout.
- **Límites:**
  - CAPTCHA/MFA: siempre los resuelve el humano.
  - Cambios de layout: se detecta un selector faltante, se aborta y se avisa con una alerta. Nunca se "adivina" un campo.
  - Sesiones con expiración corta.
- **Credenciales:** nunca en el repositorio, el prompt, los logs ni la BD del agente. Las teclea el humano en el navegador. Si se automatizara el login, se usaría un gestor de secretos (vault) con inyección directa al navegador, sin pasar por el modelo, y con rotación y auditoría.

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Confirmación por token del servidor ligado a hash, versión e identidad | Texto libre "sí, envía" interpretado por el LLM (lectura literal de CA3) | El modelo no debe poder fabricar la confirmación, y un texto no prueba qué versión vio el humano. El chat sigue mostrando la pregunta explícita |
| Postgres/PGlite con FK, UNIQUE y transacciones | Archivos en `out/` (permitido por el PRD) | Hace falta atomicidad, carreras controladas e idempotencia que sobreviva a varios procesos |
| Mapeo 100% determinista (glosario y similitud) | Pedir al LLM que mapee etiquetas | Valores trazables a una ruta del maestro y reproducibles. El LLM nunca decide qué valor va en una celda |
| Cargar y rellenar la plantilla (AcroForm en PDF) | Generar un PDF nuevo con texto (permitido por P1) | Preserva el formato del cliente y es verificable campo por campo |
| `generar_formulario` recibe el `mapeo_hash`, no los valores | Que el modelo pase el mapeo completo | Impide que el modelo inyecte o altere valores (CA2) |
| Envío con bloqueos permitido solo con confirmación que muestra los bloqueos | Prohibir el envío si no está `listo_para_firma` | El PRD §11 espera `ENVIO-SIMULADO.md` en `ec-corp-andina`, que siempre está bloqueado. Queda registrado y genera alerta crítica |

## 7. Supuestos

1. **Fecha de ejecución:** la vigencia se evalúa contra `AS_OF_DATE` o la fecha actual. Al 2026-11-10 todos los casos quedan bloqueados (Cámara de Comercio y parafiscales vencidos). `demo.ts` muestra además el escenario a la fecha de cada solicitud.
2. **Binarios de plantilla no incluidos** en los fixtures (`Formato_Proveedores_v3.xlsx`, `Registro_Proveedor_Extranjero.xlsx`, `Formulario_Calificacion_2026.pdf`). Si se colocan en la carpeta del caso, se cargan y rellenan; si no, la base se deriva una vez de la especificación de celdas/campos. Las pruebas cubren ambos caminos.
3. **"Correo electrónico"** se resuelve con el glosario (`contacto_comercial.email`) e **"Ingresos anuales"** se llena con `ingresos_ultimo_ano.valor` (COP), porque HU-2 exige resolver sinónimos automáticamente.
4. **RN1:** también se marca `requiere_confirmacion` una etiqueta tributaria genérica en Colombia ("Identificación tributaria"), según HU-1.
5. **Propiedad del caso:** un caso pertenece al primer usuario que lo abre (`UNIQUE(caso)`). Re-procesar después de un envío está permitido; reenviar el mismo contenido es idempotente.
6. **Multiusuario y autenticación** se añaden aunque el PRD no los exige, para cumplir identidad en la confirmación y sesiones no públicas.

## 8. Cobertura

| HU | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer solicitud | Hecho | `funcional.test.ts` | Ingesta real de correo y adjuntos |
| HU-2 Mapear | Hecho | `funcional.test.ts` (4 casos), RN1 | Dueño del dato maestro; versionado del glosario |
| HU-3 Formato (xlsx P0, pdf P1, portal P2) | Hecho | `anti_error_1_5.test.ts` | Plantillas binarias reales de clientes; PDF sin AcroForm (dibujar por coordenadas) |
| HU-4 Paquete y confirmación | Hecho | `anti_error_1_1/1_2`, e2e | Firma electrónica; envío real por correo |
| HU-5 Errores | Hecho | `funcional.test.ts`, e2e | Observabilidad (métricas y trazas) |
| Front con herramientas visibles y confirmación resaltada | Hecho | `web/` | Streaming; accesibilidad revisada |
| Link público | **Pendiente** | `render.yaml` | Desplegar con la cuenta del candidato |
| Bonus `modulo/` | Hecho | `tests/modulo.test.ts` (mismas piezas, sin divergencia) | Publicar como paquete npm versionado |

## 9. Uso de IA

- **Asistente:** Claude (Claude Code, modelos Opus/Sonnet 5.5) como pair-programmer.
- **Tareas:**
  - Lectura del PRD y matriz de requisitos.
  - ADR y matriz error → control → prueba.
  - Código de herramientas, servicios, ciclo y front.
  - Pruebas y CI.
  - Redacción de esta documentación.
- **Revisión humana:** la elección del reto, el ADR y el alcance las aprobó el candidato antes de escribir código.
- **Descartado de lo propuesto:**
  - **SQLite** como única BD: no da idempotencia distribuida.
  - Que el **LLM mapeara** etiquetas sin glosario: los valores dejarían de ser deterministas.
  - **Confirmar por texto libre:** el modelo podría fabricarla.
  - **Regenerar el PDF:** no preserva la plantilla.
  - Usar el campo booleano `confirmado` como autorización: se conserva por contrato, pero el servidor lo ignora como prueba.
- **Hallazgo:** un bug de migración con `pg` (las consultas multi-sentencia devuelven un arreglo) apareció al correr la suite contra Postgres 16 real y se corrigió en su propio commit.

## 10. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un faltante | Valores solo desde herramientas; `generar_formulario` usa el mapeo del servidor; prompt lo prohíbe; pruebas de "faltante = vacío" |
| Fuga de datos bancarios o personales al proveedor LLM | Vistas minimizadas + guarda de salida + espía en pruebas; acuerdo de tratamiento de datos con el proveedor; sin retención |
| Plantillas reales peores que los fixtures | Validación previa de etiquetas (aborta si no coincide); alerta; corpus de plantillas por cliente con pruebas de regresión |
| Maestro desactualizado | Dueño del dato; versión y fecha del maestro en el hash del paquete |
| Soportes vencidos no detectados | Fecha de referencia explícita en checklist y envío; alerta por bloqueo |
| Abuso del link o costos | Login, límite de tasa por IP (10/min en login), topes de tokens e iteraciones, timeout; en multi-réplica, mover el límite de tasa a Redis |
| Concurrencia multi-réplica | CAS, UNIQUE y lease ya están en la BD; `out/` debería migrar a almacenamiento de objetos con versionado |
| Auditoría y cumplimiento (EU AI Act / NIST AI RMF) | `audit_log` y JSONL; política de retención de logs; revisión periódica de alertas; registro del modelo y versión usados |
