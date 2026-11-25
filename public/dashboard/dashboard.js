const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const apiRoot = location.pathname.startsWith("/go/") ? "/go/api" : "/api";
const actionHeaders = { "Content-Type": "application/json", "X-Omnix-Action": "1" };
let data = { workflows: [], schedules: [], workflowRuns: [], customAgents: [], agents: [], skills: [], connections: [], events: [] };
let activeWorkflow = null;
let selectedNodeId = null;
let connectingFrom = null;
let dirty = false;

const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const id = () => crypto.randomUUID();
const ago = (date) => {
  if (!date) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString();
};
const dateTime = (date) => date ? new Date(date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const statusBadge = (status) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;
const empty = (message) => `<div class="empty">${esc(message)}</div>`;

async function request(path, options = {}) {
  const response = await fetch(`${apiRoot}${path}`, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.style.borderColor = error ? "#71313a" : "#365066";
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}

function showView(view) {
  $$('[data-page]').forEach((page) => page.classList.toggle("active", page.dataset.page === view));
  $$("#nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const titles = { overview: "Overview", workflows: "Workflow studio", schedules: "Schedules", agents: "Agents", runs: "Live runs", skills: "Skills", connections: "MCP connections" };
  $("#view-title").textContent = titles[view] || view;
  $("#quick-new").hidden = view === "workflows";
  history.replaceState(null, "", `#${view}`);
  if (view === "workflows") renderWorkflowEditor();
}

function metric(label, value, note) {
  return `<article class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><em>${esc(note)}</em></article>`;
}

function render() {
  const running = data.workflowRuns.filter((run) => ["queued", "running"].includes(run.status));
  const activeAgents = data.agents.filter((agent) => ["queued", "running", "needs_attention"].includes(agent.status));
  $("#metrics").innerHTML = [
    metric("Active workflows", running.length, `${data.workflows.length} saved graphs`),
    metric("Browser agents", activeAgents.length, `${data.agents.length} tracked sessions`),
    metric("Cron schedules", data.schedules.filter((item) => item.enabled).length, `${data.schedules.length} total`),
    metric("Connected tools", data.connections.reduce((sum, item) => sum + (item.toolCount || item.tools?.length || 0), 0), `${data.connections.length} MCP sources`),
  ].join("");
  $("#service-dot").classList.add("online");
  $("#service-state").textContent = "Service online";
  $("#last-sync").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  renderOverview(running);
  renderWorkflowList();
  renderSchedules();
  renderAgents();
  renderRuns();
  renderSkills();
  renderConnections();
}

function renderOverview(running) {
  $("#overview-runs").innerHTML = running.length ? running.slice(0, 5).map((run) => `
    <div class="row"><div class="row-main"><strong>${esc(run.workflowName)}</strong><p>${esc(Object.values(run.nodeRuns).find((node) => node.status === "running")?.progress || "Starting graph…")}</p></div>${statusBadge(run.status)}</div>`).join("") : empty("No workflows running.");
  const upcoming = data.schedules.filter((item) => item.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt))).slice(0, 5);
  $("#overview-schedules").innerHTML = upcoming.length ? upcoming.map((schedule) => `
    <div class="row"><div class="row-main"><strong>${esc(schedule.name)}</strong><p>${esc(schedule.cron)} · ${esc(schedule.timezone)}</p></div><span class="badge enabled">${esc(dateTime(schedule.nextRunAt))}</span></div>`).join("") : empty("No enabled schedules.");
  $("#activity").innerHTML = data.events.slice(-10).reverse().map((event) => `
    <div class="timeline-item"><i class="event-dot"></i><div><p>${esc(event.title)}</p><small>${esc(event.detail || event.kind)}</small></div><small>${ago(event.at)}</small></div>`).join("") || empty("No activity yet.");
}

function renderWorkflowList() {
  $("#workflow-list").innerHTML = data.workflows.length ? data.workflows.map((workflow) => `
    <button class="row workflow-choice" data-id="${workflow.id}"><div class="row-main"><strong>${esc(workflow.name)}</strong><p>${workflow.nodes.length} nodes · ${workflow.edges.length} links</p></div></button>`).join("") : empty("No workflows yet.");
  $$(".workflow-choice").forEach((button) => button.onclick = () => loadWorkflow(button.dataset.id));
}

function blankWorkflow() {
  return { name: "Untitled workflow", description: "", nodes: [], edges: [], enabled: true };
}

function loadWorkflow(workflowId) {
  if (dirty && !confirm("Discard unsaved workflow changes?")) return;
  activeWorkflow = structuredClone(data.workflows.find((item) => item.id === workflowId) || blankWorkflow());
  selectedNodeId = null;
  connectingFrom = null;
  dirty = false;
  showView("workflows");
}

function renderWorkflowEditor() {
  if (!activeWorkflow) activeWorkflow = data.workflows[0] ? structuredClone(data.workflows[0]) : blankWorkflow();
  $("#workflow-name").value = activeWorkflow.name;
  $("#delete-workflow").hidden = !activeWorkflow.id;
  const canvas = $("#canvas");
  $$(".flow-node", canvas).forEach((node) => node.remove());
  $("#canvas-hint").hidden = activeWorkflow.nodes.length > 0;
  activeWorkflow.nodes.forEach((node) => canvas.append(createNodeElement(node)));
  drawEdges();
  renderInspector();
}

const icons = { agent: "AI", split: "Ⅱ", join: "⋈", loop: "↻", delay: "◷", condition: "?", subworkflow: "◇" };
function createNodeElement(node) {
  const element = document.createElement("article");
  element.className = `flow-node${node.id === selectedNodeId ? " selected" : ""}`;
  element.dataset.id = node.id;
  element.style.left = `${node.x}px`;
  element.style.top = `${node.y}px`;
  element.innerHTML = `<header><span class="node-icon">${icons[node.type]}</span><strong>${esc(node.name)}</strong></header><p>${esc(node.type)}</p><i class="port in" title="Connect input"></i><i class="port out" title="Connect output"></i>`;
  element.onclick = () => { selectedNodeId = node.id; renderWorkflowEditor(); };
  $("header", element).onpointerdown = (event) => beginDrag(event, node, element);
  $(".port.out", element).onclick = (event) => { event.stopPropagation(); connectingFrom = node.id; toast("Select another node’s input"); };
  $(".port.in", element).onclick = (event) => {
    event.stopPropagation();
    if (!connectingFrom || connectingFrom === node.id) return;
    if (!activeWorkflow.edges.some((edge) => edge.source === connectingFrom && edge.target === node.id)) {
      activeWorkflow.edges.push({ id: id(), source: connectingFrom, target: node.id, sourcePort: "always" });
      dirty = true;
    }
    connectingFrom = null;
    renderWorkflowEditor();
  };
  return element;
}

function beginDrag(event, node, element) {
  event.preventDefault();
  element.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = node.x;
  const originY = node.y;
  element.onpointermove = (move) => {
    node.x = Math.max(10, originX + move.clientX - startX);
    node.y = Math.max(10, originY + move.clientY - startY);
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    dirty = true;
    drawEdges();
  };
  element.onpointerup = () => { element.onpointermove = null; element.onpointerup = null; };
}

function drawEdges() {
  const svg = $("#edges");
  svg.innerHTML = activeWorkflow.edges.map((edge) => {
    const source = activeWorkflow.nodes.find((node) => node.id === edge.source);
    const target = activeWorkflow.nodes.find((node) => node.id === edge.target);
    if (!source || !target) return "";
    const x1 = source.x + 172, y1 = source.y + 31, x2 = target.x, y2 = target.y + 31;
    const curve = Math.max(55, Math.abs(x2 - x1) * .45);
    return `<path d="M${x1},${y1} C${x1 + curve},${y1} ${x2 - curve},${y2} ${x2},${y2}" />`;
  }).join("");
}

function renderInspector() {
  const panel = $("#inspector");
  const node = activeWorkflow.nodes.find((item) => item.id === selectedNodeId);
  if (!node) { panel.innerHTML = "<p>Select a node to edit its behavior.</p>"; return; }
  const customAgentOptions = `<option value="">Inline prompt</option>${data.customAgents.map((agent) => `<option value="${agent.id}" ${node.agentTemplateId === agent.id ? "selected" : ""}>${esc(agent.name)}</option>`).join("")}`;
  const workflowOptions = data.workflows.filter((workflow) => workflow.id !== activeWorkflow.id).map((workflow) => `<option value="${workflow.id}" ${node.workflowId === workflow.id ? "selected" : ""}>${esc(workflow.name)}</option>`).join("");
  let specific = "";
  if (node.type === "agent") specific = `<div class="field"><label>Agent profile</label><select data-key="agentTemplateId">${customAgentOptions}</select></div><div class="field"><label>Prompt</label><textarea data-key="prompt" placeholder="Use {{input.topic}} variables">${esc(node.prompt || "")}</textarea></div><div class="field"><label>Workspace</label><input data-key="workspace" value="${esc(node.workspace || "")}"></div><div class="field"><label><input type="checkbox" data-key="waitForCompletion" ${node.waitForCompletion !== false ? "checked" : ""}> Wait for completion</label></div>`;
  if (node.type === "loop") specific = `<div class="field"><label>Iterations (max 50)</label><input type="number" min="1" max="50" data-key="iterations" value="${node.iterations || 2}"></div><p>Use a <b>loop</b> edge for the repeated branch and a <b>done</b> edge for the exit.</p>`;
  if (node.type === "delay") specific = `<div class="field"><label>Delay milliseconds</label><input type="number" min="0" data-key="delayMs" value="${node.delayMs || 1000}"></div>`;
  if (node.type === "condition") specific = `<div class="field"><label>Rule</label><select data-key="condition"><option value="input_truthy">Input is truthy</option><option value="input_equals" ${node.condition === "input_equals" ? "selected" : ""}>Input equals</option><option value="always" ${node.condition === "always" ? "selected" : ""}>Always true</option></select></div><div class="field"><label>Input key</label><input data-key="conditionKey" value="${esc(node.conditionKey || "")}"></div><div class="field"><label>Equals value</label><input data-key="conditionValue" value="${esc(node.conditionValue || "")}"></div>`;
  if (node.type === "subworkflow") specific = `<div class="field"><label>Workflow</label><select data-key="workflowId"><option value="">Choose…</option>${workflowOptions}</select></div>`;
  panel.innerHTML = `<h3>${esc(node.type.toUpperCase())} NODE</h3><div class="field"><label>Name</label><input data-key="name" value="${esc(node.name)}"></div>${specific}<button id="remove-node" class="danger ghost">Remove node</button>`;
  $$('[data-key]', panel).forEach((input) => input.onchange = () => {
    const key = input.dataset.key;
    node[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    dirty = true;
    renderWorkflowEditor();
  });
  $("#remove-node").onclick = () => {
    activeWorkflow.nodes = activeWorkflow.nodes.filter((item) => item.id !== node.id);
    activeWorkflow.edges = activeWorkflow.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
    selectedNodeId = null; dirty = true; renderWorkflowEditor();
  };
}

function addNode(type) {
  const count = activeWorkflow.nodes.length;
  const node = { id: id(), type, name: `${type[0].toUpperCase()}${type.slice(1)} ${count + 1}`, x: 40 + (count % 3) * 220, y: 50 + Math.floor(count / 3) * 130 };
  if (type === "agent") Object.assign(node, { prompt: "", waitForCompletion: true });
  if (type === "loop") node.iterations = 2;
  if (type === "delay") node.delayMs = 1000;
  if (type === "condition") node.condition = "input_truthy";
  activeWorkflow.nodes.push(node); selectedNodeId = node.id; dirty = true; renderWorkflowEditor();
}

function renderSchedules() {
  $("#schedule-list").innerHTML = data.schedules.length ? data.schedules.map((schedule) => `
    <article class="card"><div class="panel-head"><h3>${esc(schedule.name)}</h3>${statusBadge(schedule.enabled ? "enabled" : "paused")}</div><p>${esc(schedule.cron)}<br>${esc(schedule.timezone)}</p><p>Next: ${esc(dateTime(schedule.nextRunAt))}</p><div class="card-foot"><small>${esc(schedule.overlapPolicy)} overlap</small><div class="card-actions"><button data-cron-run="${schedule.id}">Run</button><button data-cron-toggle="${schedule.id}" data-enabled="${schedule.enabled}">${schedule.enabled ? "Pause" : "Resume"}</button><button class="danger" data-cron-delete="${schedule.id}">Delete</button></div></div></article>`).join("") : empty("Create a schedule to run a workflow automatically.");
  $$('[data-cron-run]').forEach((button) => button.onclick = () => mutate(`/crons/${button.dataset.cronRun}/run`, "POST", undefined, "Scheduled workflow started"));
  $$('[data-cron-toggle]').forEach((button) => button.onclick = () => mutate(`/crons/${button.dataset.cronToggle}/toggle`, "POST", { enabled: button.dataset.enabled !== "true" }, "Schedule updated"));
  $$('[data-cron-delete]').forEach((button) => button.onclick = () => confirm("Delete this schedule?") && mutate(`/crons/${button.dataset.cronDelete}`, "DELETE", undefined, "Schedule deleted"));
}

function renderAgents() {
  $("#custom-agent-list").innerHTML = data.customAgents.length ? data.customAgents.map((agent) => `<article class="card"><h3>${esc(agent.name)}</h3><p>${esc(agent.description || agent.prompt.slice(0, 150))}</p><div class="card-foot"><small>${agent.tags.map(esc).join(" · ")}</small><div class="card-actions"><button data-agent-run="${agent.id}">Run</button><button data-agent-edit="${agent.id}">Edit</button><button class="danger" data-agent-delete="${agent.id}">Delete</button></div></div></article>`).join("") : empty("Create a reusable agent profile.");
  $("#agent-list").innerHTML = data.agents.length ? data.agents.slice(0, 100).map((agent) => `<div class="row"><div class="row-main"><strong>${esc(agent.agentName || agent.prompt?.slice(0, 70) || agent.id)}</strong><p>${esc(agent.latestAssistant || agent.error || agent.conversationId || "Waiting for ChatGPT…")}</p>${agent.conversationUrl ? `<a href="${esc(agent.conversationUrl)}" target="_blank" rel="noreferrer">${esc(agent.conversationId || "Open conversation")}</a>` : ""}</div><div class="card-actions">${statusBadge(agent.status)}<button data-session-refresh="${agent.id}">Refresh</button>${["queued", "running", "needs_attention"].includes(agent.status) ? `<button class="danger" data-session-stop="${agent.id}">Stop</button>` : ""}</div></div>`).join("") : empty("No browser agents have run yet.");
  $$('[data-agent-run]').forEach((button) => button.onclick = () => mutate(`/custom-agents/${button.dataset.agentRun}/run`, "POST", {}, "Agent opened in ChatGPT"));
  $$('[data-agent-edit]').forEach((button) => button.onclick = () => openAgentModal(data.customAgents.find((agent) => agent.id === button.dataset.agentEdit)));
  $$('[data-agent-delete]').forEach((button) => button.onclick = () => confirm("Delete this agent profile?") && mutate(`/custom-agents/${button.dataset.agentDelete}`, "DELETE", undefined, "Agent deleted"));
  $$('[data-session-refresh]').forEach((button) => button.onclick = () => mutate(`/agents/${button.dataset.sessionRefresh}/refresh`, "POST", {}, "Agent refreshed"));
  $$('[data-session-stop]').forEach((button) => button.onclick = () => mutate(`/agents/${button.dataset.sessionStop}/cancel`, "POST", {}, "Agent stopped"));
}

function renderRuns() {
  $("#run-list").innerHTML = data.workflowRuns.length ? data.workflowRuns.map((run) => `<article class="run-row"><div><div class="panel-head"><h2>${esc(run.workflowName)}</h2>${statusBadge(run.status)}</div><p class="eyebrow">${esc(run.trigger)} · ${ago(run.createdAt)} · ${esc(run.id)}</p><div class="run-progress">${Object.values(run.nodeRuns).map((node) => `<span class="node-chip ${node.status}" title="${esc(node.progress || node.error || "")}">${esc(node.nodeId.slice(0, 8))} · ${esc(node.status)}${node.visits > 1 ? ` ×${node.visits}` : ""}</span>`).join("")}</div>${Object.values(run.nodeRuns).flatMap((node) => node.conversationUrls || []).map((url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">Open ChatGPT session</a>`).join(" · ")}</div>${["queued", "running"].includes(run.status) ? `<button class="danger" data-run-stop="${run.id}">Stop run</button>` : ""}</article>`).join("") : empty("No workflow runs yet.");
  $$('[data-run-stop]').forEach((button) => button.onclick = () => mutate(`/runs/${button.dataset.runStop}/cancel`, "POST", {}, "Workflow stopped"));
}

function renderSkills() {
  $("#skill-list").innerHTML = data.skills.length ? data.skills.map((skill) => `<div class="row"><div class="row-main"><strong>${esc(skill.name)}</strong><p>${esc(skill.description || skill.path)}</p></div><span class="badge ${skill.valid ? "enabled" : "failed"}">${esc(skill.source)}</span></div>`).join("") : empty("No skills discovered.");
}

function renderConnections() {
  $("#connection-list").innerHTML = data.connections.length ? data.connections.map((connection) => `<div class="row"><div class="row-main"><strong>${esc(connection.name || connection.id)}</strong><p>${esc(connection.transport)} · ${esc(connection.url || connection.command || "")} · ${connection.toolCount ?? connection.tools?.length ?? 0} tools</p></div><div class="card-actions">${statusBadge(connection.status || (connection.connected ? "connected" : "configured"))}${connection.managed ? "" : `<button class="danger" data-mcp-delete="${connection.id}">Disconnect</button>`}</div></div>`).join("") : empty("No MCP connections.");
  $$('[data-mcp-delete]').forEach((button) => button.onclick = () => confirm("Disconnect this MCP?") && mutate(`/connections/${button.dataset.mcpDelete}`, "DELETE", undefined, "MCP disconnected"));
}

async function mutate(path, method, body, success) {
  try {
    await request(path, { method, headers: actionHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    toast(success); await refresh();
  } catch (error) { toast(error.message, true); }
}

function openModal(title, body, submitLabel, onSubmit) {
  const dialog = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-submit").textContent = submitLabel;
  $("#modal-form").onsubmit = async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    try { await onSubmit(new FormData(event.currentTarget)); dialog.close(); } catch (error) { toast(error.message, true); }
  };
  dialog.showModal();
}

function openAgentModal(agent = {}) {
  openModal(agent.id ? "Edit custom agent" : "New custom agent", `<input type="hidden" name="id" value="${esc(agent.id || "")}"><div class="field"><label>Name</label><input required name="name" value="${esc(agent.name || "")}"></div><div class="field"><label>Description</label><input name="description" value="${esc(agent.description || "")}"></div><div class="field"><label>System prompt</label><textarea required name="prompt">${esc(agent.prompt || "")}</textarea></div><div class="field"><label>Workspace</label><input name="workspace" value="${esc(agent.workspace || "")}"></div><div class="field"><label>Evaluation commands (one per line)</label><textarea name="evaluationCommands">${esc((agent.evaluationCommands || []).join("\n"))}</textarea></div>`, "Save agent", async (form) => {
    await request("/custom-agents", { method: "POST", headers: actionHeaders, body: JSON.stringify({ id: form.get("id") || undefined, name: form.get("name"), description: form.get("description"), prompt: form.get("prompt"), workspace: form.get("workspace"), evaluationCommands: String(form.get("evaluationCommands") || "").split("\n").filter(Boolean), tags: agent.tags || [] }) });
    toast("Custom agent saved"); await refresh();
  });
}

function openScheduleModal() {
  const options = data.workflows.map((workflow) => `<option value="${workflow.id}">${esc(workflow.name)}</option>`).join("");
  openModal("New schedule", `<div class="field"><label>Name</label><input required name="name" placeholder="Hourly review"></div><div class="field"><label>Workflow</label><select required name="workflowId">${options}</select></div><div class="field"><label>Cron expression</label><input required name="cron" value="@hourly"></div><div class="field"><label>Timezone</label><input required name="timezone" value="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}"></div><div class="field"><label>Overlap</label><select name="overlapPolicy"><option value="skip">Skip if already running</option><option value="parallel">Run in parallel</option></select></div><div class="field"><label>Input JSON</label><textarea name="input">{}</textarea></div>`, "Create schedule", async (form) => {
    await request("/crons", { method: "POST", headers: actionHeaders, body: JSON.stringify({ name: form.get("name"), workflowId: form.get("workflowId"), cron: form.get("cron"), timezone: form.get("timezone"), overlapPolicy: form.get("overlapPolicy"), input: JSON.parse(form.get("input") || "{}"), enabled: true }) });
    toast("Schedule created"); await refresh();
  });
}

function openConnectionModal() {
  openModal("Connect MCP", `<div class="field"><label>Name</label><input required name="name"></div><div class="field"><label>Transport</label><select name="transport"><option value="http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select></div><div class="field"><label>URL (HTTP / SSE)</label><input name="url" placeholder="https://example.com/mcp"></div><div class="field"><label>Command (stdio)</label><input name="command" placeholder="npx"></div><div class="field"><label>Arguments (one per line)</label><textarea name="args"></textarea></div>`, "Connect", async (form) => {
    await request("/connections", { method: "POST", headers: actionHeaders, body: JSON.stringify({ id: String(form.get("name")).toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + id().slice(0, 6), name: form.get("name"), transport: form.get("transport"), url: form.get("url") || undefined, command: form.get("command") || undefined, args: String(form.get("args") || "").split("\n").filter(Boolean), enabled: true }) });
    toast("MCP connected and tools refreshed"); await refresh();
  });
}

async function saveWorkflow() {
  activeWorkflow.name = $("#workflow-name").value.trim();
  if (!activeWorkflow.name) return toast("Workflow name is required", true);
  try {
    const result = await request("/workflows", { method: "POST", headers: actionHeaders, body: JSON.stringify(activeWorkflow) });
    activeWorkflow = structuredClone(result.workflow); dirty = false; toast("Workflow saved"); await refresh(false); renderWorkflowEditor();
  } catch (error) { toast(error.message, true); }
}

async function refresh(renderEditor = true) {
  try {
    data = await request("/state");
    render();
    if (renderEditor && $("[data-page=workflows]").classList.contains("active")) renderWorkflowEditor();
  } catch (error) {
    $("#service-state").textContent = "Disconnected";
    $("#service-dot").classList.remove("online");
    toast(error.message, true);
  }
}

$("#nav").onclick = (event) => event.target.dataset.view && showView(event.target.dataset.view);
$$('[data-go]').forEach((button) => button.onclick = () => showView(button.dataset.go));
$("#quick-new").onclick = $("#new-workflow").onclick = () => { activeWorkflow = blankWorkflow(); dirty = false; selectedNodeId = null; showView("workflows"); };
$("#node-palette").onclick = (event) => event.target.dataset.node && addNode(event.target.dataset.node);
$("#workflow-name").oninput = () => { if (activeWorkflow) { activeWorkflow.name = $("#workflow-name").value; dirty = true; } };
$("#save-workflow").onclick = saveWorkflow;
$("#run-workflow").onclick = async () => { if (dirty || !activeWorkflow.id) await saveWorkflow(); if (activeWorkflow.id) await mutate(`/workflows/${activeWorkflow.id}/run`, "POST", { input: {} }, "Workflow started"); };
$("#delete-workflow").onclick = () => activeWorkflow.id && confirm("Delete this workflow?") && mutate(`/workflows/${activeWorkflow.id}`, "DELETE", undefined, "Workflow deleted").then(() => { activeWorkflow = null; });
$("#new-schedule").onclick = openScheduleModal;
$("#new-agent").onclick = () => openAgentModal();
$("#new-connection").onclick = openConnectionModal;
$("#refresh-skills").onclick = () => mutate("/skills/refresh", "POST", {}, "Skills refreshed");
window.addEventListener("beforeunload", (event) => { if (dirty) event.preventDefault(); });

const initialView = location.hash.slice(1) || "overview";
showView($( `[data-page="${initialView}"]`) ? initialView : "overview");
await refresh();
setInterval(refresh, 5000);
try {
  const stream = new EventSource(`${apiRoot}/events`);
  stream.onmessage = () => refresh();
} catch {}
