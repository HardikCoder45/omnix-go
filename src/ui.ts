const UI_BASE = "ui://chatgpt-code";

export const TOOL_UI_MIME_TYPE = "text/html+skybridge";

const VIEW_BY_TOOL: Record<string, string> = {
  create_plan: "plan",
  get_plan: "plan",
  list_plans: "plan",
  update_plan: "plan",
  complete_plan: "plan",
  read_file: "code",
  list_directory: "directory",
  search_files: "search",
  write_file: "diff",
  edit_file: "diff",
  git_diff: "diff",
  apply_patch: "diff",
  run_command: "terminal",
  start_command: "terminal",
  terminal_status: "terminal",
  terminal_input: "terminal",
  terminal_stop: "terminal",
  git_status: "git-status",
  list_skills: "skills",
  refresh_skills: "skills",
  connect_mcp: "mcp",
  list_connected_mcps: "mcp",
  inspect_connected_mcp_tools: "mcp",
  start_agent: "agents",
  agent_status: "agents",
  list_agents: "agents",
  computer_screenshot: "image",
  recent_activity: "activity",
  show_activity_dashboard: "activity",
};

export const TOOL_UI_TEMPLATE = `${UI_BASE}/tool-result-v6.html`;

export function toolUiUri(toolName: string): string {
  void toolName;
  return TOOL_UI_TEMPLATE;
}

export function toolUiView(toolName: string): string {
  return VIEW_BY_TOOL[toolName] ?? "auto";
}

export function renderToolUi(template: string, toolName: string): string {
  // ponytail: one template, distinct MCP resources; split files only if views truly diverge.
  const view = toolUiView(toolName);
  return template
    .replaceAll("__CHATGPT_CODE_TOOL_NAME__", toolName.replaceAll(/["<>&]/g, ""))
    .replaceAll("__CHATGPT_CODE_TOOL_VIEW__", view);
}
