import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChatGptConversationSnapshot,
  ChatGptMessage,
} from "./types.js";

const ARC_APP_PATH = "/Applications/Arc.app";
const SAFARI_APP_PATH = "/Applications/Safari.app";
const CHROME_APP_PATH = "/Applications/Google Chrome.app";
const BRAVE_APP_PATH = "/Applications/Brave Browser.app";
const EDGE_APP_PATH = "/Applications/Microsoft Edge.app";
const CHROMIUM_APP_PATH = "/Applications/Chromium.app";
const VIVALDI_APP_PATH = "/Applications/Vivaldi.app";
const OPERA_APP_PATH = "/Applications/Opera.app";
const CHATGPT_URL = "https://chatgpt.com/";
const NO_SUBAGENT_INSTRUCTION =
  "Execution boundary: Do not spawn, delegate to, or ask any subagent or nested agent to work on this task. Complete the work yourself using the available OmniX tools.";
const DEFAULT_TIMEOUT_MS = 30_000;
const RESPONSE_START_TIMEOUT_MS = 15_000;
const APPLE_SCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const ROW_SEPARATOR = String.fromCharCode(30);
const COLUMN_SEPARATOR = String.fromCharCode(31);

export type BrowserAutomationFamily = "arc" | "chromium" | "safari";

export interface BrowserDescriptor {
  bundleId: string;
  name: string;
  appPath: string;
  family: BrowserAutomationFamily;
}

const BROWSER_DESCRIPTORS: BrowserDescriptor[] = [
  { bundleId: "company.thebrowser.browser", name: "Arc", appPath: ARC_APP_PATH, family: "arc" },
  { bundleId: "com.google.Chrome", name: "Google Chrome", appPath: CHROME_APP_PATH, family: "chromium" },
  { bundleId: "com.brave.Browser", name: "Brave Browser", appPath: BRAVE_APP_PATH, family: "chromium" },
  { bundleId: "com.microsoft.edgemac", name: "Microsoft Edge", appPath: EDGE_APP_PATH, family: "chromium" },
  { bundleId: "org.chromium.Chromium", name: "Chromium", appPath: CHROMIUM_APP_PATH, family: "chromium" },
  { bundleId: "com.vivaldi.Vivaldi", name: "Vivaldi", appPath: VIVALDI_APP_PATH, family: "chromium" },
  { bundleId: "com.operasoftware.Opera", name: "Opera", appPath: OPERA_APP_PATH, family: "chromium" },
  { bundleId: "com.apple.Safari", name: "Safari", appPath: SAFARI_APP_PATH, family: "safari" },
];

export function browserDescriptorForBundleId(
  bundleId: string | undefined,
): BrowserDescriptor | undefined {
  if (!bundleId) return undefined;
  const normalized = bundleId.trim().toLowerCase();
  return BROWSER_DESCRIPTORS.find(
    (browser) => browser.bundleId.toLowerCase() === normalized,
  );
}

function launchServicesHandlerBlocks(raw: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

function handlerBundleId(block: string): string | undefined {
  const matches = [
    ...block.matchAll(/LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?\s*;/g),
  ];
  const bundleId = matches.at(-1)?.[1];
  return bundleId && bundleId !== "-" ? bundleId : undefined;
}

export function parseDefaultBrowserBundleId(raw: string): string | undefined {
  const blocks = launchServicesHandlerBlocks(raw);
  for (const block of blocks) {
    const scheme = /LSHandlerURLScheme\s*=\s*"?([^";\s]+)"?\s*;/.exec(block)?.[1];
    if (scheme?.toLowerCase() !== "https") continue;
    const bundleId = handlerBundleId(block);
    if (bundleId) return bundleId;
  }
  for (const block of blocks) {
    if (!/LSHandlerContentType\s*=\s*"?com\.apple\.default-app\.web-browser"?\s*;/.test(block)) {
      continue;
    }
    const bundleId = handlerBundleId(block);
    if (bundleId) return bundleId;
  }
  return undefined;
}

export interface AgentConversationTarget {
  tabId?: string;
  conversationId?: string;
  conversationUrl?: string;
}

export interface AgentBrowser {
  createConversation(prompt: string): Promise<ChatGptConversationSnapshot>;
  readConversation(
    target: AgentConversationTarget,
  ): Promise<ChatGptConversationSnapshot>;
  sendMessage(
    target: AgentConversationTarget,
    prompt: string,
  ): Promise<ChatGptConversationSnapshot>;
  stopConversation(target: AgentConversationTarget): Promise<{
    stopped: boolean;
    snapshot: ChatGptConversationSnapshot;
  }>;
}

interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

interface SnapshotPayload {
  url: string;
  title: string;
  state: ChatGptConversationSnapshot["state"];
  messages: ChatGptMessage[];
  pageText: string;
  latestAssistant?: string;
  userMessageCount: number;
  assistantMessageCount: number;
  diagnostic?: string;
}

interface ComposerProbe {
  url: string;
  hasComposer: boolean;
  responding: boolean;
  loginRequired: boolean;
  diagnostic?: string;
}

interface ConversationCollection {
  messages: ChatGptMessage[];
  pageText: string;
  userMessageCount: number;
  assistantMessageCount: number;
  missingTurnIds?: string[];
}

interface CollectorStep {
  done: boolean;
  count: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  collection?: ConversationCollection;
}

export interface DefaultChatGptBrowserOptions {
  browser?: BrowserDescriptor;
  timeoutMs?: number;
}

export interface ArcChatGptBrowserOptions {
  appPath?: string;
  timeoutMs?: number;
}

export function parseConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const urlMatch = /(?:^|\/)c\/([A-Za-z0-9_-]{8,})(?:[/?#]|$)/.exec(trimmed);
  if (urlMatch?.[1]) return urlMatch[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(trimmed) ? trimmed : undefined;
}

export function formatAgentPrompt(input: {
  prompt: string;
  workspace?: string;
  evaluationCommands?: string[];
}): string {
  const cleanPrompt = input.prompt
    .trim()
    .replace(/^@omnix(?:\s+go)?\b[\s:,-]*/i, "")
    .trim();
  if (!cleanPrompt) throw new Error("Agent prompt is empty after the @OmniX Go prefix.");

  const sections = [cleanPrompt];
  if (input.workspace) {
    sections.push(`Workspace: ${input.workspace}`);
  }
  if (input.evaluationCommands?.length) {
    sections.push(
      `Verification commands:\n${input.evaluationCommands.map((command) => `- ${command}`).join("\n")}`,
    );
  }
  return `@OmniX Go\n\n${sections.join("\n\n")}\n\n${NO_SUBAGENT_INSTRUCTION}`;
}

function decodeAppleScriptValue(raw: string): unknown {
  let value: unknown = raw.trim();
  for (let index = 0; index < 3 && typeof value === "string"; index += 1) {
    const candidate = value.trim();
    if (!candidate) return "";
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed === value) break;
      value = parsed;
    } catch {
      break;
    }
  }
  return value;
}

function friendlyBrowserError(error: unknown, browser: BrowserDescriptor): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("-1743") || /not authorized.*Apple Events/i.test(message)) {
    return new Error(
      `macOS blocked ${browser.name} automation. Enable Automation access for the OmniX Go process in System Settings → Privacy & Security → Automation, then retry.`,
    );
  }
  if (/execute javascript|do JavaScript|JavaScript.*Apple Events|-1708/i.test(message)) {
    return new Error(
      `${browser.name} could not execute page JavaScript. Enable its "Allow JavaScript from Apple Events" developer/automation setting, then retry.`,
    );
  }
  if (/Application isn.?t running|not found|-600/i.test(message)) {
    return new Error(`${browser.name} is not running or could not be opened.`);
  }
  return new Error(`${browser.name} ChatGPT automation failed: ${message}`);
}

async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out.`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > APPLE_SCRIPT_MAX_BYTES && !settled) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error(`${path.basename(command)} returned more data than the safety limit.`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorOutput || output || `${path.basename(command)} exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

export async function detectDefaultBrowser(): Promise<BrowserDescriptor> {
  if (process.platform !== "darwin") {
    throw new Error("ChatGPT conversation-backed agents currently require macOS browser automation.");
  }
  const raw = await runProcess(
    "/usr/bin/defaults",
    ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
    { timeoutMs: 5_000 },
  );
  const bundleId = parseDefaultBrowserBundleId(raw);
  const browser = browserDescriptorForBundleId(bundleId);
  if (!browser) {
    throw new Error(
      `The macOS default browser (${bundleId ?? "unknown"}) is not supported for ChatGPT page automation. Supported defaults: ${BROWSER_DESCRIPTORS.map((item) => item.name).join(", ")}.`,
    );
  }
  await access(browser.appPath).catch(() => {
    throw new Error(`${browser.name} is configured as the default browser but is not installed at ${browser.appPath}.`);
  });
  return browser;
}

async function runAppleScript(
  script: string,
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", [], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Browser automation timed out."));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > APPLE_SCRIPT_MAX_BYTES && !settled) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error("Browser automation returned more data than the safety limit."));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorOutput || output || `osascript exited with code ${code}`));
        return;
      }
      resolve(output);
    });
    child.stdin.end(script);
  });
}

function listTabsScript(browser: BrowserDescriptor): string {
  if (browser.family === "arc") {
    return `
set rowSeparator to ASCII character 30
set columnSeparator to ASCII character 31
set rows to {}
tell application "Arc"
  set windowCount to count of windows
  repeat with windowIndex from 1 to windowCount
    try
      set activeId to ""
      try
        set activeId to id of active tab of window windowIndex as text
      end try
      set tabCount to count of tabs of window windowIndex
      repeat with tabIndex from 1 to tabCount
        try
          set tabId to id of tab tabIndex of window windowIndex as text
          set tabUrl to ""
          set tabTitle to ""
          try
            set tabUrl to URL of tab tabIndex of window windowIndex as text
          end try
          try
            set tabTitle to title of tab tabIndex of window windowIndex as text
          end try
          set end of rows to (tabId & columnSeparator & tabUrl & columnSeparator & tabTitle & columnSeparator & activeId)
        end try
      end repeat
    end try
  end repeat
end tell
set AppleScript's text item delimiters to rowSeparator
return rows as text
`;
  }
  if (browser.family === "chromium") {
    return `
set rowSeparator to ASCII character 30
set columnSeparator to ASCII character 31
set rows to {}
set targetApp to system attribute "OMNIX_BROWSER_NAME"
using terms from application "Google Chrome"
  tell application targetApp
    repeat with w in windows
      set activeId to ""
      try
        set activeId to id of active tab of w as text
      end try
      repeat with t in tabs of w
        set tabId to id of t as text
        set tabUrl to ""
        set tabTitle to ""
        try
          set tabUrl to URL of t as text
        end try
        try
          set tabTitle to title of t as text
        end try
        set end of rows to (tabId & columnSeparator & tabUrl & columnSeparator & tabTitle & columnSeparator & activeId)
      end repeat
    end repeat
  end tell
end using terms from
set AppleScript's text item delimiters to rowSeparator
return rows as text
`;
  }
  return `
set rowSeparator to ASCII character 30
set columnSeparator to ASCII character 31
set rows to {}
tell application "Safari"
  repeat with w in windows
    set windowId to id of w as text
    set activeId to ""
    try
      set activeId to windowId & ":" & (index of current tab of w as text)
    end try
    repeat with t in tabs of w
      set tabId to windowId & ":" & (index of t as text)
      set tabUrl to ""
      set tabTitle to ""
      try
        set tabUrl to URL of t as text
      end try
      try
        set tabTitle to name of t as text
      end try
      set end of rows to (tabId & columnSeparator & tabUrl & columnSeparator & tabTitle & columnSeparator & activeId)
    end repeat
  end repeat
end tell
set AppleScript's text item delimiters to rowSeparator
return rows as text
`;
}

function createTabScript(browser: BrowserDescriptor): string {
  if (browser.family === "arc") {
    return `
set targetUrl to system attribute "OMNIX_URL"
tell application "Arc"
  activate
  if (count of windows) is 0 then error "Arc has no open window."
  tell front window to make new tab with properties {URL:targetUrl}
end tell
return "created"
`;
  }
  if (browser.family === "chromium") {
    return `
set targetUrl to system attribute "OMNIX_URL"
set targetApp to system attribute "OMNIX_BROWSER_NAME"
using terms from application "Google Chrome"
  tell application targetApp
    activate
    if (count of windows) is 0 then make new window
    tell front window
      make new tab with properties {URL:targetUrl}
      set active tab index to count of tabs
    end tell
  end tell
end using terms from
return "created"
`;
  }
  return `
set targetUrl to system attribute "OMNIX_URL"
tell application "Safari"
  activate
  if (count of windows) is 0 then
    make new document with properties {URL:targetUrl}
  else
    tell front window
      set current tab to (make new tab with properties {URL:targetUrl})
    end tell
  end if
end tell
return "created"
`;
}

function setTabUrlScript(browser: BrowserDescriptor): string {
  if (browser.family === "arc") {
    return `
set targetId to system attribute "OMNIX_TAB_ID"
set targetUrl to system attribute "OMNIX_URL"
tell application "Arc"
  set windowCount to count of windows
  repeat with windowIndex from 1 to windowCount
    try
      set tabCount to count of tabs of window windowIndex
      repeat with tabIndex from 1 to tabCount
        try
          if (id of tab tabIndex of window windowIndex as text) is targetId then
            set URL of tab tabIndex of window windowIndex to targetUrl
            return "navigated"
          end if
        end try
      end repeat
    end try
  end repeat
end tell
error "Arc tab not found: " & targetId
`;
  }
  if (browser.family === "chromium") {
    return `
set targetId to system attribute "OMNIX_TAB_ID"
set targetUrl to system attribute "OMNIX_URL"
set targetApp to system attribute "OMNIX_BROWSER_NAME"
using terms from application "Google Chrome"
  tell application targetApp
    repeat with w in windows
      repeat with t in tabs of w
        if (id of t as text) is targetId then
          set URL of t to targetUrl
          return "navigated"
        end if
      end repeat
    end repeat
  end tell
end using terms from
error targetApp & " tab not found: " & targetId
`;
  }
  return `
set targetId to system attribute "OMNIX_TAB_ID"
set targetUrl to system attribute "OMNIX_URL"
tell application "Safari"
  repeat with w in windows
    set windowId to id of w as text
    repeat with t in tabs of w
      set tabId to windowId & ":" & (index of t as text)
      if tabId is targetId then
        set URL of t to targetUrl
        return "navigated"
      end if
    end repeat
  end repeat
end tell
error "Safari tab not found: " & targetId
`;
}

function executeJavaScriptScript(browser: BrowserDescriptor): string {
  if (browser.family === "arc") {
    return `
set targetId to system attribute "OMNIX_TAB_ID"
set jsPath to system attribute "OMNIX_JS_PATH"
set sourceCode to read POSIX file jsPath as «class utf8»
tell application "Arc"
  set windowCount to count of windows
  repeat with windowIndex from 1 to windowCount
    try
      set tabCount to count of tabs of window windowIndex
      repeat with tabIndex from 1 to tabCount
        try
          if (id of tab tabIndex of window windowIndex as text) is targetId then
            return execute tab tabIndex of window windowIndex javascript sourceCode
          end if
        end try
      end repeat
    end try
  end repeat
end tell
error "Arc tab not found: " & targetId
`;
  }
  if (browser.family === "chromium") {
    return `
set targetId to system attribute "OMNIX_TAB_ID"
set jsPath to system attribute "OMNIX_JS_PATH"
set sourceCode to read POSIX file jsPath as «class utf8»
set targetApp to system attribute "OMNIX_BROWSER_NAME"
using terms from application "Google Chrome"
  tell application targetApp
    repeat with w in windows
      repeat with t in tabs of w
        if (id of t as text) is targetId then
          return execute t javascript sourceCode
        end if
      end repeat
    end repeat
  end tell
end using terms from
error targetApp & " tab not found: " & targetId
`;
  }
  return `
set targetId to system attribute "OMNIX_TAB_ID"
set jsPath to system attribute "OMNIX_JS_PATH"
set sourceCode to read POSIX file jsPath as «class utf8»
tell application "Safari"
  repeat with w in windows
    set windowId to id of w as text
    repeat with t in tabs of w
      set tabId to windowId & ":" & (index of t as text)
      if tabId is targetId then
        return do JavaScript sourceCode in t
      end if
    end repeat
  end repeat
end tell
error "Safari tab not found: " & targetId
`;
}

const SNAPSHOT_SOURCE = String.raw`(() => {
  const visible = (element) => Boolean(
    element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
  );
  const composerCandidates = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('[data-testid="prompt-textarea"]'),
    document.querySelector('main div[contenteditable="true"]'),
    document.querySelector('form div[contenteditable="true"]')
  ];
  const composer = composerCandidates.find(visible) || null;
  const stopButton = Array.from(document.querySelectorAll('button[data-testid="stop-button"]'))
    .find(visible) || null;
  const messages = Array.from(document.querySelectorAll('[data-message-author-role]')).map((element, index) => {
    const rawRole = element.getAttribute('data-message-author-role') || 'unknown';
    const role = ['user', 'assistant', 'system', 'tool'].includes(rawRole) ? rawRole : 'unknown';
    const turn = element.closest('[data-testid^="conversation-turn-"]');
    return {
      id: turn?.getAttribute('data-testid') || ('conversation-turn-' + index),
      role,
      text: (element.innerText || element.textContent || '').trim()
    };
  }).filter((message) => message.text);
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = assistantMessages.length;
  const loginRequired = !composer && (
    /\/auth(?:\/|$)|\/login(?:\/|$)/i.test(location.pathname) ||
    Array.from(document.querySelectorAll('a,button')).some((element) => {
      const text = (element.innerText || element.textContent || '').trim();
      return visible(element) && /^(log in|sign up)$/i.test(text);
    })
  );
  const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  const state = loginRequired
    ? 'login_required'
    : stopButton
      ? 'responding'
      : composer
        ? 'ready'
        : 'unavailable';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    state,
    messages,
    pageText: (main?.innerText || main?.textContent || '').trim(),
    latestAssistant: assistantMessages.at(-1)?.text,
    userMessageCount,
    assistantMessageCount,
    diagnostic: state === 'unavailable'
      ? ('readyState=' + document.readyState + '; composer=false; stop=false')
      : undefined
  });
})()`;

const PROBE_SOURCE = String.raw`(() => {
  const visible = (element) => Boolean(
    element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
  );
  const composer = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('[data-testid="prompt-textarea"]'),
    document.querySelector('main div[contenteditable="true"]'),
    document.querySelector('form div[contenteditable="true"]')
  ].find(visible) || null;
  const responding = Boolean(
    Array.from(document.querySelectorAll('button[data-testid="stop-button"]')).find(visible)
  );
  const loginRequired = !composer && (
    /\/auth(?:\/|$)|\/login(?:\/|$)/i.test(location.pathname) ||
    Array.from(document.querySelectorAll('a,button')).some((element) => {
      const text = (element.innerText || element.textContent || '').trim();
      return visible(element) && /^(log in|sign up)$/i.test(text);
    })
  );
  return JSON.stringify({
    url: location.href,
    hasComposer: Boolean(composer),
    responding,
    loginRequired,
    diagnostic: composer ? undefined : ('readyState=' + document.readyState)
  });
})()`;

function fillComposerSource(message: string): string {
  return `(() => {
    const message = ${JSON.stringify(message)};
    const visible = (element) => Boolean(
      element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
    );
    const composer = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('[data-testid="prompt-textarea"]'),
      document.querySelector('main div[contenteditable="true"]'),
      document.querySelector('form div[contenteditable="true"]')
    ].find(visible) || null;
    if (!composer) return JSON.stringify({ ok: false, reason: 'composer-not-found' });
    if (Array.from(document.querySelectorAll('button[data-testid="stop-button"]')).find(visible)) {
      return JSON.stringify({ ok: false, reason: 'conversation-responding' });
    }
    const beforeUserCount = document.querySelectorAll('[data-message-author-role="user"]').length;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      descriptor?.set?.call(composer, message);
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: message
      }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand('insertText', false, message);
      if (!inserted || (composer.innerText || composer.textContent || '').trim() !== message.trim()) {
        composer.replaceChildren(document.createTextNode(message));
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: message
        }));
      }
    }
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, beforeUserCount });
  })()`;
}

const SEND_READY_SOURCE = String.raw`(() => {
  const visible = (element) => Boolean(
    element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
  );
  const composer = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('[data-testid="prompt-textarea"]'),
    document.querySelector('main div[contenteditable="true"]'),
    document.querySelector('form div[contenteditable="true"]')
  ].find(visible) || null;
  if (!composer) return JSON.stringify({ ready: false, reason: 'composer-not-found' });
  const scope = composer.closest('form') || composer.parentElement?.parentElement?.parentElement || document;
  const candidates = [
    document.querySelector('button[data-testid="send-button"]'),
    ...Array.from(scope.querySelectorAll('button'))
  ].filter(Boolean);
  const button = candidates.find((candidate) => {
    if (!visible(candidate) || candidate.disabled) return false;
    if (candidate.getAttribute('data-testid') === 'send-button') return true;
    const label = (candidate.getAttribute('aria-label') || '').trim();
    return /^(send|send prompt|send message)$/i.test(label);
  });
  return JSON.stringify({ ready: Boolean(button), reason: button ? undefined : 'send-button-not-ready' });
})()`;

const CLICK_SEND_SOURCE = String.raw`(() => {
  const visible = (element) => Boolean(
    element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
  );
  const composer = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('[data-testid="prompt-textarea"]'),
    document.querySelector('main div[contenteditable="true"]'),
    document.querySelector('form div[contenteditable="true"]')
  ].find(visible) || null;
  if (!composer) return JSON.stringify({ clicked: false, reason: 'composer-not-found' });
  const scope = composer.closest('form') || composer.parentElement?.parentElement?.parentElement || document;
  const candidates = [
    document.querySelector('button[data-testid="send-button"]'),
    ...Array.from(scope.querySelectorAll('button'))
  ].filter(Boolean);
  const button = candidates.find((candidate) => {
    if (!visible(candidate) || candidate.disabled) return false;
    if (candidate.getAttribute('data-testid') === 'send-button') return true;
    const label = (candidate.getAttribute('aria-label') || '').trim();
    return /^(send|send prompt|send message)$/i.test(label);
  });
  if (!button) return JSON.stringify({ clicked: false, reason: 'send-button-not-found' });
  button.click();
  return JSON.stringify({ clicked: true });
})()`;

const CLICK_STOP_SOURCE = String.raw`(() => {
  const visible = (element) => Boolean(
    element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length)
  );
  const button = Array.from(document.querySelectorAll('button[data-testid="stop-button"]'))
    .find((candidate) => visible(candidate) && !candidate.disabled) || null;
  if (!button) return JSON.stringify({ stopped: false });
  button.click();
  return JSON.stringify({ stopped: true });
})()`;

const START_COLLECTOR_SOURCE = String.raw`(() => {
  const main = document.querySelector('main');
  const candidates = [];
  let current = main;
  while (current) {
    if (current.scrollHeight > current.clientHeight + 100 && current.clientHeight > 200) {
      candidates.push(current);
    }
    current = current.parentElement;
  }
  const explicitlyScrollable = candidates.filter((element) => {
    const overflowY = getComputedStyle(element).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  });
  const pool = explicitlyScrollable.length ? explicitlyScrollable : candidates;
  const scroller = pool.sort(
    (left, right) =>
      (right.scrollHeight - right.clientHeight) -
      (left.scrollHeight - left.clientHeight)
  )[0] || null;
  const state = {
    scroller,
    originalTop: scroller ? scroller.scrollTop : 0,
    turns: {},
    collect() {
      Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]')).forEach((turn, index) => {
        const id = turn.getAttribute('data-testid') || ('conversation-turn-' + index);
        const roleNode = turn.querySelector('[data-message-author-role]');
        const rawRole = roleNode?.getAttribute('data-message-author-role') || '';
        let role = ['user', 'assistant', 'system', 'tool'].includes(rawRole)
          ? rawRole
          : 'unknown';
        if (role === 'unknown') {
          const numericId = Number.parseInt(id.split('-').at(-1) || '', 10);
          if (Number.isFinite(numericId)) role = numericId % 2 === 0 ? 'assistant' : 'user';
        }
        const contentNode = roleNode || turn;
        const text = (contentNode.innerText || contentNode.textContent || '').trim();
        if (!text) return;
        const numericOrder = Number.parseInt(id.split('-').at(-1) || '', 10);
        const candidate = {
          id,
          role,
          text,
          order: Number.isFinite(numericOrder) ? numericOrder : index
        };
        const previous = this.turns[id];
        if (!previous || candidate.text.length >= previous.text.length) this.turns[id] = candidate;
      });
    },
    result() {
      const messages = Object.values(this.turns)
        .sort((left, right) => left.order - right.order)
        .map(({ id, role, text }) => ({ id, role, text }));
      const numericTurns = new Set(messages.map((message) =>
        Number.parseInt(message.id.split('-').at(-1) || '', 10)
      ).filter(Number.isFinite));
      const maximumTurn = numericTurns.size ? Math.max(...numericTurns) : 0;
      const missingTurnIds = [];
      for (let turn = 1; turn <= maximumTurn; turn += 1) {
        if (!numericTurns.has(turn)) missingTurnIds.push('conversation-turn-' + turn);
      }
      return {
        messages,
        pageText: messages.map((message) =>
          message.role.toUpperCase() + ':\n' + message.text
        ).join('\n\n'),
        userMessageCount: messages.filter((message) => message.role === 'user').length,
        assistantMessageCount: messages.filter((message) => message.role === 'assistant').length,
        missingTurnIds
      };
    }
  };
  window.__omnixAgentCollector = state;
  state.collect();
  if (scroller) scroller.scrollTop = 0;
  return JSON.stringify({
    done: !scroller,
    count: Object.keys(state.turns).length,
    scrollTop: scroller?.scrollTop || 0,
    scrollHeight: scroller?.scrollHeight || 0,
    clientHeight: scroller?.clientHeight || 0,
    collection: scroller ? undefined : state.result()
  });
})()`;

const STEP_COLLECTOR_SOURCE = String.raw`(() => {
  const state = window.__omnixAgentCollector;
  if (!state) return JSON.stringify({
    done: true,
    count: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    collection: { messages: [], pageText: '', userMessageCount: 0, assistantMessageCount: 0 }
  });
  state.collect();
  const scroller = state.scroller;
  if (!scroller) return JSON.stringify({
    done: true,
    count: Object.keys(state.turns).length,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    collection: state.result()
  });
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const atBottom = scroller.scrollTop >= maximum - 4;
  if (atBottom) {
    const collection = state.result();
    scroller.scrollTop = state.originalTop;
    delete window.__omnixAgentCollector;
    return JSON.stringify({
      done: true,
      count: collection.messages.length,
      scrollTop: maximum,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      collection
    });
  }
  const step = Math.max(300, Math.floor(scroller.clientHeight * 0.75));
  scroller.scrollTop = Math.min(maximum, scroller.scrollTop + step);
  return JSON.stringify({
    done: false,
    count: Object.keys(state.turns).length,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight
  });
})()`;

const FINISH_COLLECTOR_SOURCE = String.raw`(() => {
  const state = window.__omnixAgentCollector;
  if (!state) return JSON.stringify({
    done: true,
    count: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    collection: { messages: [], pageText: '', userMessageCount: 0, assistantMessageCount: 0 }
  });
  state.collect();
  const collection = state.result();
  if (state.scroller) state.scroller.scrollTop = state.originalTop;
  delete window.__omnixAgentCollector;
  return JSON.stringify({
    done: true,
    count: collection.messages.length,
    scrollTop: state.originalTop,
    scrollHeight: state.scroller?.scrollHeight || 0,
    clientHeight: state.scroller?.clientHeight || 0,
    collection
  });
})()`;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function targetConversationUrl(target: AgentConversationTarget): string | undefined {
  if (target.conversationUrl) return target.conversationUrl;
  if (target.conversationId) return `${CHATGPT_URL}c/${target.conversationId}`;
  return undefined;
}

export class DefaultChatGptBrowser implements AgentBrowser {
  private browser?: BrowserDescriptor;
  private readonly timeoutMs: number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: DefaultChatGptBrowserOptions = {}) {
    this.browser = options.browser;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async currentBrowser(): Promise<BrowserDescriptor> {
    this.browser ??= await detectDefaultBrowser();
    return this.browser;
  }

  async createConversation(prompt: string): Promise<ChatGptConversationSnapshot> {
    return this.withMutationLock(async () => {
      await this.ensureAvailable();
      const tab = await this.createTab(CHATGPT_URL);
      await this.waitForComposer(tab.id, true);
      return this.submitPrompt(tab.id, prompt);
    });
  }

  async readConversation(
    target: AgentConversationTarget,
  ): Promise<ChatGptConversationSnapshot> {
    return this.withMutationLock(async () => {
      await this.ensureAvailable();
      const tab = await this.resolveTab(target);
      await this.waitForDocument(tab.id);
      return this.snapshot(tab.id);
    });
  }

  async sendMessage(
    target: AgentConversationTarget,
    prompt: string,
  ): Promise<ChatGptConversationSnapshot> {
    return this.withMutationLock(async () => {
      await this.ensureAvailable();
      const tab = await this.resolveTab(target);
      await this.waitForComposer(tab.id, true);
      return this.submitPrompt(tab.id, prompt);
    });
  }

  async stopConversation(target: AgentConversationTarget): Promise<{
    stopped: boolean;
    snapshot: ChatGptConversationSnapshot;
  }> {
    return this.withMutationLock(async () => {
      await this.ensureAvailable();
      const tab = await this.resolveTab(target);
      const result = await this.executeJson<{ stopped: boolean }>(
        tab.id,
        CLICK_STOP_SOURCE,
      );
      if (result.stopped) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const snapshot = await this.snapshot(tab.id, false);
          if (snapshot.state !== "responding") {
            return { stopped: true, snapshot: await this.snapshot(tab.id) };
          }
          await delay(200);
        }
      }
      return { stopped: result.stopped, snapshot: await this.snapshot(tab.id) };
    });
  }

  private async ensureAvailable(): Promise<void> {
    const browser = await this.currentBrowser();
    await access(browser.appPath).catch(() => {
      throw new Error(`${browser.name} is not installed at ${browser.appPath}.`);
    });
    try {
      await this.listTabs();
    } catch (error) {
      throw friendlyBrowserError(error, browser);
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: (() => void) | undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async listTabs(): Promise<BrowserTab[]> {
    const browser = await this.currentBrowser();
    const raw = await runAppleScript(listTabsScript(browser), {
      env: { OMNIX_BROWSER_NAME: browser.name },
      timeoutMs: this.timeoutMs,
    });
    if (!raw) return [];
    return raw
      .split(ROW_SEPARATOR)
      .map((row) => row.split(COLUMN_SEPARATOR))
      .filter((columns) => columns[0])
      .map(([id = "", url = "", title = "", activeId = ""]) => ({
        id,
        url,
        title,
        active: id === activeId,
      }));
  }

  private async createTab(url: string): Promise<BrowserTab> {
    const browser = await this.currentBrowser();
    const before = new Set((await this.listTabs()).map((tab) => tab.id));
    await runAppleScript(createTabScript(browser), {
      env: { OMNIX_URL: url, OMNIX_BROWSER_NAME: browser.name },
      timeoutMs: this.timeoutMs,
    });
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const tabs = await this.listTabs();
      const created = tabs
        .filter((tab) => !before.has(tab.id))
        .find((tab) => tab.url.startsWith("https://chatgpt.com"));
      if (created) return created;
      const matching = tabs.find((tab) => tab.url === url && !before.has(tab.id));
      if (matching) return matching;
      await delay(200);
    }
    throw new Error(`${browser.name} opened ChatGPT, but the new tab could not be identified.`);
  }

  private async resolveTab(target: AgentConversationTarget): Promise<BrowserTab> {
    const tabs = await this.listTabs();
    const conversationId =
      target.conversationId ?? parseConversationId(target.conversationUrl);
    if (conversationId) {
      const matchingConversation = tabs.find(
        (tab) => parseConversationId(tab.url) === conversationId,
      );
      if (matchingConversation) return matchingConversation;
    }
    if (target.conversationUrl) {
      const matchingUrl = tabs.find((tab) => tab.url === target.conversationUrl);
      if (matchingUrl) return matchingUrl;
    }
    if (target.tabId) {
      const matchingTab = tabs.find((tab) => tab.id === target.tabId);
      if (matchingTab) {
        const matchesPersistedConversation = conversationId
          ? parseConversationId(matchingTab.url) === conversationId
          : target.conversationUrl
            ? matchingTab.url === target.conversationUrl
            : true;
        if (matchesPersistedConversation) return matchingTab;
      }
    }

    const url = targetConversationUrl(target);
    if (!url) throw new Error("The agent has no browser tab or ChatGPT conversation URL.");
    return this.createTab(url);
  }

  private async setTabUrl(tabId: string, url: string): Promise<void> {
    const browser = await this.currentBrowser();
    await runAppleScript(setTabUrlScript(browser), {
      env: {
        OMNIX_TAB_ID: tabId,
        OMNIX_URL: url,
        OMNIX_BROWSER_NAME: browser.name,
      },
      timeoutMs: this.timeoutMs,
    });
  }

  private async executeJavaScript(tabId: string, source: string): Promise<unknown> {
    const browser = await this.currentBrowser();
    const directory = await mkdtemp(path.join(os.tmpdir(), "omnix-browser-js-"));
    const sourcePath = path.join(directory, "source.js");
    try {
      await writeFile(sourcePath, source, { encoding: "utf8", mode: 0o600 });
      const raw = await runAppleScript(executeJavaScriptScript(browser), {
        env: {
          OMNIX_TAB_ID: tabId,
          OMNIX_JS_PATH: sourcePath,
          OMNIX_BROWSER_NAME: browser.name,
        },
        timeoutMs: this.timeoutMs,
      });
      return decodeAppleScriptValue(raw);
    } catch (error) {
      throw friendlyBrowserError(error, browser);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async executeJson<T>(tabId: string, source: string): Promise<T> {
    const value = await this.executeJavaScript(tabId, source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const browser = await this.currentBrowser();
      throw new Error(`${browser.name} returned an unexpected page result: ${String(value)}`);
    }
    return value as T;
  }

  private async waitForDocument(tabId: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let lastDiagnostic = "page not ready";
    while (Date.now() < deadline) {
      try {
        const probe = await this.executeJson<ComposerProbe>(tabId, PROBE_SOURCE);
        if (probe.loginRequired || probe.hasComposer || probe.responding) return;
        lastDiagnostic = probe.diagnostic ?? lastDiagnostic;
      } catch (error) {
        lastDiagnostic = error instanceof Error ? error.message : String(error);
      }
      await delay(250);
    }
    const browser = await this.currentBrowser();
    throw new Error(`ChatGPT did not become readable in ${browser.name}: ${lastDiagnostic}`);
  }

  private async waitForComposer(tabId: string, requireIdle: boolean): Promise<void> {
    const browser = await this.currentBrowser();
    const deadline = Date.now() + this.timeoutMs;
    let lastDiagnostic = "composer not found";
    while (Date.now() < deadline) {
      const probe = await this.executeJson<ComposerProbe>(tabId, PROBE_SOURCE);
      if (probe.loginRequired) {
        throw new Error(
          `ChatGPT is not signed in in ${browser.name}. Sign in to chatgpt.com there, then retry the agent tool.`,
        );
      }
      if (probe.hasComposer) {
        if (requireIdle && probe.responding) {
          throw new Error(
            "This ChatGPT agent is still responding. Call agent_status later or cancel_agent before sending a follow-up.",
          );
        }
        return;
      }
      lastDiagnostic = probe.diagnostic ?? lastDiagnostic;
      await delay(250);
    }
    throw new Error(
      `Could not find the ChatGPT composer in ${browser.name}. The page structure may have changed (${lastDiagnostic}).`,
    );
  }

  private async submitPrompt(
    tabId: string,
    prompt: string,
  ): Promise<ChatGptConversationSnapshot> {
    const fill = await this.executeJson<{
      ok: boolean;
      reason?: string;
      beforeUserCount?: number;
    }>(tabId, fillComposerSource(prompt));
    if (!fill.ok) {
      throw new Error(`Could not fill the ChatGPT composer: ${fill.reason ?? "unknown error"}.`);
    }

    const sendDeadline = Date.now() + 7_500;
    let sendReason = "send-button-not-ready";
    while (Date.now() < sendDeadline) {
      const readiness = await this.executeJson<{ ready: boolean; reason?: string }>(
        tabId,
        SEND_READY_SOURCE,
      );
      if (readiness.ready) break;
      sendReason = readiness.reason ?? sendReason;
      await delay(100);
    }
    const click = await this.executeJson<{ clicked: boolean; reason?: string }>(
      tabId,
      CLICK_SEND_SOURCE,
    );
    if (!click.clicked) {
      throw new Error(
        `ChatGPT's scoped send button was not clickable (${click.reason ?? sendReason}).`,
      );
    }

    const beforeUserCount = fill.beforeUserCount ?? 0;
    const deadline = Date.now() + RESPONSE_START_TIMEOUT_MS;
    let lastSnapshot: ChatGptConversationSnapshot | undefined;
    while (Date.now() < deadline) {
      lastSnapshot = await this.snapshot(tabId, false);
      const submitted = lastSnapshot.userMessageCount > beforeUserCount;
      if (submitted && lastSnapshot.conversationId) return lastSnapshot;
      await delay(200);
    }
    if (lastSnapshot && lastSnapshot.userMessageCount > beforeUserCount) {
      return lastSnapshot;
    }
    throw new Error(
      "The ChatGPT send button was clicked, but the submitted user turn could not be verified.",
    );
  }

  private async collectConversation(
    tabId: string,
  ): Promise<ConversationCollection | undefined> {
    let collectorActive = false;
    let collectorRestored = false;
    try {
      let step = await this.executeJson<CollectorStep>(tabId, START_COLLECTOR_SOURCE);
      collectorActive = true;
      if (step.done) return step.collection;

      const deadline = Date.now() + Math.min(this.timeoutMs, 30_000);
      let previousTop = -1;
      let stagnantSteps = 0;
      while (Date.now() < deadline) {
        await delay(80);
        step = await this.executeJson<CollectorStep>(tabId, STEP_COLLECTOR_SOURCE);
        if (step.done) {
          collectorRestored = true;
          return step.collection;
        }
        if (Math.abs(step.scrollTop - previousTop) < 1) stagnantSteps += 1;
        else stagnantSteps = 0;
        previousTop = step.scrollTop;
        if (stagnantSteps >= 5) break;
      }

      const finalStep = await this.executeJson<CollectorStep>(
        tabId,
        FINISH_COLLECTOR_SOURCE,
      );
      collectorRestored = true;
      return finalStep.collection;
    } finally {
      if (collectorActive && !collectorRestored) {
        await this.executeJson<CollectorStep>(tabId, FINISH_COLLECTOR_SOURCE).catch(
          () => undefined,
        );
      }
    }
  }

  private async snapshot(
    tabId: string,
    comprehensive = true,
  ): Promise<ChatGptConversationSnapshot> {
    const browser = await this.currentBrowser();
    const payload = await this.executeJson<SnapshotPayload>(tabId, SNAPSHOT_SOURCE);
    const collection =
      comprehensive &&
      payload.state !== "login_required" &&
      payload.state !== "unavailable"
        ? await this.collectConversation(tabId)
        : undefined;
    const messages = collection?.messages.length
      ? collection.messages
      : payload.messages;
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant")?.text ?? payload.latestAssistant;
    const diagnostic = [
      payload.diagnostic,
      collection?.missingTurnIds?.length
        ? `ChatGPT did not expose these current-branch turn nodes in the main conversation DOM: ${collection.missingTurnIds.join(", ")}.`
        : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ") || undefined;
    return {
      tabId,
      browser: browser.name,
      ...(parseConversationId(payload.url)
        ? { conversationId: parseConversationId(payload.url) }
        : {}),
      conversationUrl: payload.url,
      title: payload.title,
      state: payload.state,
      messages,
      pageText: payload.pageText,
      ...(latestAssistant ? { latestAssistant } : {}),
      userMessageCount:
        collection?.userMessageCount ?? payload.userMessageCount,
      assistantMessageCount:
        collection?.assistantMessageCount ?? payload.assistantMessageCount,
      capturedAt: new Date().toISOString(),
      ...(diagnostic ? { diagnostic } : {}),
    };
  }

  /** Read-only smoke helper used by diagnostics and tests. */
  async snapshotByUrl(conversationUrl: string): Promise<ChatGptConversationSnapshot> {
    return this.readConversation({
      conversationUrl,
      conversationId: parseConversationId(conversationUrl),
    });
  }

  /** Navigate a persisted tab explicitly when a conversation URL has changed. */
  async navigateTab(tabId: string, conversationUrl: string): Promise<void> {
    await this.setTabUrl(tabId, conversationUrl);
    await this.waitForDocument(tabId);
  }
}

/** Backward-compatible explicit Arc adapter for callers/tests that still need it. */
export class ArcChatGptBrowser extends DefaultChatGptBrowser {
  constructor(options: ArcChatGptBrowserOptions = {}) {
    super({
      browser: {
        bundleId: "company.thebrowser.browser",
        name: "Arc",
        appPath: options.appPath ?? ARC_APP_PATH,
        family: "arc",
      },
      timeoutMs: options.timeoutMs,
    });
  }
}
