// Front de chat sin dependencias. Muestra cada llamada a herramienta y resalta las confirmaciones humanas.
const $ = (id) => document.getElementById(id)
let sessionId = null
let busy = false

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) }, credentials: "same-origin" })
  const body = await res.json().catch(() => ({ ok: false, error: "Respuesta ilegible del servidor." }))
  if (res.status === 401) showLogin()
  return { status: res.status, body }
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
function scroll() { $("messages").scrollTop = $("messages").scrollHeight }

// Markdown mínimo y seguro para respuestas del modelo: primero se escapa TODO el HTML, luego solo se insertan etiquetas fijas.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
function md(text) {
  return escapeHtml(text)
    .replace(/^#{1,4} (.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^[-*] /gm, "• ")
}

function addMsg(role, text, extra = "") {
  const div = el("div", `msg ${role} ${extra}`)
  if (role === "assistant") div.innerHTML = md(text)
  else div.textContent = text
  $("messages").appendChild(div)
  scroll()
}

function addTool(tc) {
  const d = el("details", `tool ${tc.ok ? "" : "fail"}`)
  const s = el("summary", "", `🔧 ${tc.nombre} — ${tc.ok ? "ok" : tc.resumen}`)
  d.appendChild(s)
  d.appendChild(el("div", "muted small", "Argumentos:"))
  d.appendChild(el("pre", "", JSON.stringify(tc.argumentos, null, 2)))
  d.appendChild(el("div", "muted small", "Resultado:"))
  d.appendChild(el("pre", "", JSON.stringify(tc.resultado, null, 2)))
  $("messages").appendChild(d)
  scroll()
}

function addConfirm(c) {
  const box = el("div", "confirm")
  box.appendChild(el("h3", "", "⚠ Se requiere tu confirmación explícita"))
  box.appendChild(el("div", "", c.resumen))
  const ul = el("ul")
  ul.appendChild(el("li", "", `Caso: ${c.caso} · versión ${c.version}`))
  ul.appendChild(el("li", "", `Hash del paquete: ${c.payloadHash.slice(0, 16)}…`))
  ul.appendChild(el("li", "", `Listo para firma: ${c.listoParaFirma ? "sí" : "NO"}`))
  for (const b of c.bloqueos) ul.appendChild(el("li", "", `Bloqueo: ${b}`))
  ul.appendChild(el("li", "", `Expira: ${new Date(c.expiresAt).toLocaleString()}`))
  box.appendChild(ul)
  const ok = el("button", "warn", "Confirmar envío")
  const no = el("button", "secondary", "Cancelar")
  const out = el("div", "small")
  ok.onclick = async () => {
    ok.disabled = no.disabled = true
    const r = await api("/api/confirmaciones", { method: "POST", body: JSON.stringify({ token: c.token }) })
    out.textContent = r.body.ok ? `✔ ${r.body.repetido ? "Ya estaba enviado (idempotente)" : "Envío simulado registrado"}: ${r.body.ruta}` : `✖ ${r.body.error}`
    out.className = r.body.ok ? "" : "error"
    loadAlerts()
  }
  no.onclick = () => { ok.disabled = no.disabled = true; out.textContent = "Cancelado. No se envió nada." }
  box.append(ok, no, out)
  $("messages").appendChild(box)
  scroll()
}

function renderHistory(mensajes) {
  $("messages").innerHTML = ""
  for (const m of mensajes) {
    const c = m.content
    if (m.role === "user") addMsg("user", c.content)
    else if (m.role === "assistant" && c.content) addMsg("assistant", c.content)
    else if (m.role === "tool") {
      let r = {}
      try { r = JSON.parse(c.content) } catch {}
      addTool({ nombre: c.name, ok: r.ok, resumen: r.error || "ok", argumentos: "(ver turno original)", resultado: r })
    } else if (m.role === "event") addMsg("event", c.content)
  }
}

async function send(text) {
  if (busy || !text.trim()) return
  busy = true
  $("send").disabled = true
  $("thinking").classList.remove("hidden")
  addMsg("user", text)
  const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: text }) })
  $("thinking").classList.add("hidden")
  busy = false
  $("send").disabled = false
  if (!r.body.ok) return addMsg("assistant", r.body.error || "Error", "error")
  for (const tc of r.body.toolCalls) addTool(tc)
  addMsg("assistant", r.body.reply, r.body.error ? "error" : "")
  if (r.body.needsConfirmation) addConfirm(r.body.needsConfirmation)
  loadAlerts()
}

async function loadAlerts() {
  const r = await api("/api/alertas")
  const ul = $("alerts")
  ul.innerHTML = ""
  for (const a of r.body.alertas || []) ul.appendChild(el("li", `sev-${a.severidad}`, `[${a.severidad}] ${a.mensaje}`))
  if (!ul.children.length) ul.appendChild(el("li", "muted", "Sin alertas"))
}

async function newSession() {
  const r = await api("/api/sessions", { method: "POST", body: "{}" })
  sessionId = r.body.sessionId
  localStorage.setItem("sessionId", sessionId)
  $("messages").innerHTML = ""
  addMsg("assistant", "Hola. Indícame qué caso procesar. Preparo el formulario y el paquete; nunca envío nada sin tu confirmación explícita.")
  $("sessionInfo").textContent = `ID: ${sessionId}`
}

async function boot() {
  const me = await api("/api/me")
  if (!me.body.ok) return showLogin()
  $("login").classList.add("hidden")
  $("app").classList.remove("hidden")
  const h = await api("/api/health")
  $("meta").textContent = `${me.body.email} · LLM ${h.body.provider}/${h.body.model} · vigencias al ${me.body.fechaReferencia}`
  $("examples").innerHTML = ""
  for (const c of me.body.casos) {
    const b = el("button", "", `Procesa ${c}`)
    b.onclick = () => send(`Procesa el caso "${c}". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.`)
    $("examples").appendChild(b)
  }
  const envia = el("button", "", "envía")
  envia.onclick = () => send("envía")
  $("examples").appendChild(envia)
  const saved = localStorage.getItem("sessionId")
  const hist = saved ? await api(`/api/sessions/${saved}`) : null
  if (hist && hist.body.ok) {
    sessionId = saved
    $("sessionInfo").textContent = `ID: ${sessionId}`
    renderHistory(hist.body.mensajes)
  } else await newSession()
  loadAlerts()
}

function showLogin() {
  $("app").classList.add("hidden")
  $("login").classList.remove("hidden")
}

$("loginForm").onsubmit = async (e) => {
  e.preventDefault()
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ email: $("email").value, password: $("password").value }) })
  if (!r.body.ok) return ($("loginError").textContent = r.body.error)
  $("loginError").textContent = ""
  boot()
}
$("chatForm").onsubmit = (e) => { e.preventDefault(); const t = $("input").value; $("input").value = ""; send(t) }
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit() } })
$("newSession").onclick = newSession
$("logout").onclick = async () => { await api("/api/logout", { method: "POST", body: "{}" }); localStorage.removeItem("sessionId"); showLogin() }
boot()
