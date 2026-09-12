import type { ConnectorKind } from "../membrane.js";
import type { SecretRef } from "../secret-ref.js";
import { secretRef } from "../secret-ref.js";

export interface EmailReadOperation {
  readonly name: string;
  readonly method: "GET";
  readonly kind: "poll" | "download" | "get";
  readonly description: string;
}

const GMAIL_READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

const GMAIL_READ_OPERATIONS: readonly EmailReadOperation[] = [
  {
    name: "users.messages.list",
    method: "GET",
    kind: "poll",
    description: "List mailbox threads for the last sync window.",
  },
  {
    name: "users.messages.get",
    method: "GET",
    kind: "download",
    description: "Download one message. Metadata XOR body, never modify.",
  },
  {
    name: "users.history.list",
    method: "GET",
    kind: "poll",
    description: "Poll Gmail historyId for incremental sync.",
  },
  {
    name: "users.labels.list",
    method: "GET",
    kind: "get",
    description: "Read labels used to filter the demo batch.",
  },
];

/**
 * Phase-1 Gmail connector. OAuth is a SecretRef stub, not a live token dance.
 * Scopes are metadata and calendar read-only. Send and modify are absent.
 */
export interface GmailConnectorDefinition {
  readonly connectorId: "gmail-readonly";
  readonly connectorKind: Extract<ConnectorKind, "gmail">;
  readonly transport: "POLLING";
  readonly displayName: "Gmail";
  readonly discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest";
  readonly oauth: {
    readonly authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth";
    readonly tokenUrl: "https://oauth2.googleapis.com/token";
    readonly scopes: typeof GMAIL_READONLY_SCOPES;
    readonly clientSecret: SecretRef;
    readonly refreshToken: SecretRef;
  };
  readonly operations: readonly EmailReadOperation[];
  readonly forbiddenOperations: readonly string[];
}

export const gmailReadonlyConnector: GmailConnectorDefinition = {
  connectorId: "gmail-readonly",
  connectorKind: "gmail",
  transport: "POLLING",
  displayName: "Gmail",
  discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
  oauth: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: GMAIL_READONLY_SCOPES,
    clientSecret: secretRef("gmail.oauth.client_secret"),
    refreshToken: secretRef("gmail.oauth.refresh_token"),
  },
  operations: GMAIL_READ_OPERATIONS,
  forbiddenOperations: [
    "users.messages.send",
    "users.messages.modify",
    "users.messages.delete",
    "users.messages.insert",
    "users.drafts.create",
    "users.drafts.send",
    "users.settings.filters.create",
  ],
};

const IMAP_READ_OPERATIONS: readonly EmailReadOperation[] = [
  {
    name: "LIST",
    method: "GET",
    kind: "get",
    description: "List mailbox folders.",
  },
  {
    name: "SELECT",
    method: "GET",
    kind: "get",
    description: "Select INBOX read-only (EXAMINE, not SELECT-for-write).",
  },
  {
    name: "FETCH",
    method: "GET",
    kind: "download",
    description: "Fetch RFC822 or ENVELOPE. No STORE/FLAGS writes.",
  },
  {
    name: "IDLE",
    method: "GET",
    kind: "poll",
    description: "Idle until new EXISTS. Read-only wait.",
  },
];

/**
 * IMAP-shaped twin of the Gmail connector for hosts that speak mailboxes,
 * not Google Discovery. Password is a SecretRef. No APPEND/STORE.
 */
export interface ImapConnectorDefinition {
  readonly connectorId: "imap-readonly";
  readonly connectorKind: Extract<ConnectorKind, "imap">;
  readonly transport: "POLLING";
  readonly displayName: "IMAP";
  readonly host: string;
  readonly port: 993;
  readonly mailbox: "INBOX";
  readonly examineOnly: true;
  readonly credentials: {
    readonly username: SecretRef;
    readonly password: SecretRef;
  };
  readonly operations: readonly EmailReadOperation[];
  readonly forbiddenOperations: readonly string[];
}

export const imapReadonlyConnector = (
  host: string
): ImapConnectorDefinition => ({
  connectorId: "imap-readonly",
  connectorKind: "imap",
  transport: "POLLING",
  displayName: "IMAP",
  host,
  port: 993,
  mailbox: "INBOX",
  examineOnly: true,
  credentials: {
    username: secretRef("imap.username"),
    password: secretRef("imap.password"),
  },
  operations: IMAP_READ_OPERATIONS,
  forbiddenOperations: ["APPEND", "STORE", "EXPUNGE", "DELETE", "RENAME"],
});

export const GMAIL_READONLY_SCOPES_LIST = GMAIL_READONLY_SCOPES;
