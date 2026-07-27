const state = {
  filter: "all",
  events: [],
  skills: [],
  agents: [],
  connections: [],
  service: {},
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const titles = {
  all: "EVERYTHING, AS IT HAPPENS.",
  terminal: "COMMANDS HAVE CONSEQUENCES.",
  file: "THE FILESYSTEM, EXPOSED.",
  diff: "EVERY CHANGE, ACCOUNTED FOR.",
  skill: "LOCAL KNOWLEDGE, INDEXED.",
  mcp: "TOOLS CONNECTED IN REAL TIME.",
  agent: "PARALLEL WORK, UNDER WATCH.",
  computer: "THE SCREEN IS PART OF THE LOOP.",
};

function detailFor(event) {
  if (event.kind === "diff" && event.data?.diff) {
    return `<pre class="event-detail diff-body">${event.data.diff.split("\n").map((line) => {
      const type = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
      return `<span class="diff-line ${type}">${escapeHtml(line)}</span>`;
    }).join("")}</pre>`;
  }
  const detail = event.detail || (event.data ? JSON.stringify(event.data, null, 2) : "");
  return detail ? `<pre class="event-detail">${escapeHtml(detail)}</pre>` : "";
}

function renderEvents() {
  const feed = $("#event-feed");
  const filtered = state.events.filter((event) => state.filter === "all" || event.kind === state.filter);
  if (!filtered.length) {
    feed.innerHTML = `<div class="empty-state"><span>∷</span><p>Waiting for ${escapeHtml(state.filter)} activity.</p></div>`;
    return;
  }
  feed.innerHTML = filtered.slice(-180).reverse().map((event) => `
    <article class="event" data-kind="${escapeHtml(event.kind)}">
      <div class="event-head">
        <span class="event-kind">${escapeHtml(event.kind.toUpperCase())}</span>
        <div class="event-title">${escapeHtml(event.title)}<small>${escapeHtml(event.status.toUpperCase())}</small></div>
        <time class="event-time">${new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
      </div>
      ${detailFor(event)}
    </article>`).join("");
}

function renderSidebars() {
  $("#count-events").textContent = state.events.length;
  $("#count-skills").textContent = state.skills.length;
  $("#count-agents").textContent = state.agents.length;
  $("#count-mcps").textContent = state.connections.filter((item) => item.connected).length;
  const active = state.agents.filter((task) => ["queued", "running"].includes(task.status));
  $("#agent-indicator").textContent = `${active.length} ACTIVE`;
  $("#agent-list").innerHTML = state.agents.slice(0, 5).map((task) => `
    <div class="stack-item"><strong>${escapeHtml(task.prompt)}</strong>
      <small><span class="${task.status}">${escapeHtml(task.status.toUpperCase())}</span><span>${task.id.slice(0, 8)}</span></small>
    </div>`).join("") || `<div class="stack-item"><small>NO AGENT TASKS</small></div>`;
  const connected = state.connections.filter((item) => item.connected);
  $("#mcp-indicator").textContent = `${connected.length} ONLINE`;
  $("#mcp-list").innerHTML = state.connections.slice(0, 5).map((item) => `
    <div class="stack-item"><strong>${escapeHtml(item.name)}</strong>
      <small><span class="${item.connected ? "connected" : "failed"}">${item.connected ? "CONNECTED" : "OFFLINE"}</span><span>${item.toolCount} TOOLS</span></small>
    </div>`).join("") || `<div class="stack-item"><small>NO UPSTREAM MCPS</small></div>`;
  renderSkills();
}

function renderSkills() {
  const needle = $("#skill-search")?.value.toLowerCase() || "";
  $("#skill-list").innerHTML = state.skills
    .filter((skill) => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
    .slice(0, 120)
    .map((skill) => `<span class="skill-chip ${skill.valid ? "" : "invalid"}" title="${escapeHtml(skill.description)}">${escapeHtml(skill.name)}</span>`)
    .join("");
}

async function initialize() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(`Dashboard state failed: ${response.status}`);
  Object.assign(state, await response.json());
  $("#service-status").textContent = "ONLINE / AUTHENTICATED";
  $("#root-display").textContent = `ROOT / ${state.service.roots?.[0] || "—"}`;
  renderEvents();
  renderSidebars();
  const stream = new EventSource(`/api/events?after=${state.events.at(-1)?.id || 0}`);
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    state.events.push(event);
    if (state.events.length > 2000) state.events.shift();
    if (event.kind === "agent" || event.kind === "mcp" || event.kind === "skill") {
      void refreshState();
    } else {
      renderEvents();
      $("#count-events").textContent = state.events.length;
    }
  };
  stream.onerror = () => { $("#service-status").textContent = "RECONNECTING"; };
  stream.onopen = () => { $("#service-status").textContent = "ONLINE / AUTHENTICATED"; };
}

async function refreshState() {
  const response = await fetch("/api/state");
  if (!response.ok) return;
  const fresh = await response.json();
  state.skills = fresh.skills;
  state.agents = fresh.agents;
  state.connections = fresh.connections;
  renderEvents();
  renderSidebars();
}

document.querySelectorAll(".rail-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(".rail-button.active")?.classList.remove("active");
    button.classList.add("active");
    state.filter = button.dataset.filter;
    $("#view-title").textContent = titles[state.filter];
    renderEvents();
  });
});
$("#skill-search").addEventListener("input", renderSkills);
const updateClock = () => { $("#clock").textContent = new Date().toLocaleTimeString([], { hour12: false }); };
updateClock();
setInterval(updateClock, 1000);

initialize().catch((error) => {
  $("#service-status").textContent = "FAILED";
  $("#event-feed").innerHTML = `<div class="empty-state"><span>!</span><p>${escapeHtml(error.message)}</p></div>`;
});
