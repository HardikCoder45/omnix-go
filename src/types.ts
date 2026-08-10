export type EventKind =
  | "system"
  | "tool"
  | "plan"
  | "terminal"
  | "file"
  | "diff"
  | "skill"
  | "mcp"
  | "agent"
  | "computer"
  | "security";

export interface ActivityEvent {
  id: number;
  at: string;
  kind: EventKind;
  title: string;
  status: "info" | "running" | "success" | "error" | "warning";
  detail?: string;
  data?: unknown;
}

export interface UpstreamConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  managed?: boolean;
}

export interface AppConfig {
  host: string;
  port: number;
  publicUrl?: string;
  gatewayName?: string;
  gatewayOwnerUserId?: string;
  workspaceRoots: string[];
  skillRoots: string[];
  dataDir: string;
  dashboardToken: string;
  pairingSecretHash?: string;
  jwtPrivateJwk: JsonWebKey;
  jwtPublicJwk: JsonWebKey;
  upstreams: UpstreamConfig[];
  maxParallelAgents: number;
  commandTimeoutMs: number;
}

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  root: string;
  source: "codex" | "claude" | "agents" | "other";
  modifiedAt: string;
  files: string[];
  valid: boolean;
  warnings: string[];
}

export type ChatGptMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "unknown";

export interface ChatGptMessage {
  id: string;
  role: ChatGptMessageRole;
  text: string;
}

export type ChatGptConversationState =
  | "responding"
  | "ready"
  | "login_required"
  | "unavailable";

export interface ChatGptConversationSnapshot {
  tabId: string;
  browser?: string;
  conversationId?: string;
  conversationUrl: string;
  title: string;
  state: ChatGptConversationState;
  messages: ChatGptMessage[];
  pageText: string;
  latestAssistant?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  capturedAt: string;
  diagnostic?: string;
}

export interface AgentTask {
  id: string;
  prompt: string;
  workspace: string;
  model?: string;
  backend?: "codex" | "chatgpt";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  output: string;
  exitCode?: number;
  agentName?: string;
  batchId?: string;
  browser?: string;
  tabId?: string;
  conversationId?: string;
  conversationUrl?: string;
  conversationState?: ChatGptConversationState;
  transcript?: ChatGptMessage[];
  pageText?: string;
  latestAssistant?: string;
  lastSyncedAt?: string;
  messagesSent?: number;
  error?: string;
  evaluation?: {
    commands: string[];
    passed?: boolean;
    output?: string;
  };
}

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PlanStatus = "active" | "completed";

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  verification?: string;
  status: PlanStepStatus;
  notes: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkPlan {
  id: string;
  goal: string;
  context?: string;
  successCriteria: string[];
  assumptions: string[];
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outcome?: string;
  evidence?: string[];
}
