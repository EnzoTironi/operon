import { Schema } from "effect";

import { defineLinkType } from "./link-type.js";
import type { LinkType } from "./link-type.js";
import { defineObjectType } from "./object-type.js";
import type { ObjectType } from "./object-type.js";
import type { ProposalChangeSet } from "./proposals.js";

const stringList = Schema.Array(Schema.String);

/**
 * Kernel object types for the email path. These four are the type budget:
 * Pessoa and Organização are master, Conversa is observation, Compromisso
 * is transaction. Do not add a fifth.
 */
export const PessoaType = defineObjectType({
  description: "Person identified by a normalized email address",
  id: "Pessoa",
  name: "Pessoa",
  primaryKey: "id",
  properties: {
    displayName: {
      description: "Display name as seen on the message",
      required: true,
      schema: Schema.String,
    },
    emails: {
      description: "Normalized email addresses; extras stay as a list",
      required: true,
      schema: stringList,
    },
    id: { description: "Stable person identifier", schema: Schema.String },
    phones: {
      description: "Phone numbers; extras stay as a list",
      schema: stringList,
    },
    title: {
      description:
        "Job title; more than one value is contested, not a new type",
      schema: Schema.String,
    },
  },
  typology: "master",
});

export const OrganizacaoType = defineObjectType({
  description: "Organization identified by a non-public mail domain",
  id: "Organização",
  name: "Organização",
  primaryKey: "id",
  properties: {
    domain: {
      description: "Registrable mail domain, lower-case",
      required: true,
      schema: Schema.String,
    },
    id: {
      description: "Stable organization identifier",
      schema: Schema.String,
    },
    legalName: {
      description: "Legal name as a value, not a type",
      schema: Schema.String,
    },
    tradeName: {
      description: "Trade name as a value, not a type",
      schema: Schema.String,
    },
  },
  typology: "master",
});

export const ConversaType = defineObjectType({
  description: "Email thread kept as evidence, not as a business fact",
  id: "Conversa",
  name: "Conversa",
  primaryKey: "id",
  properties: {
    folder: {
      description: "Mailbox folder, for provenance",
      schema: Schema.String,
    },
    id: {
      description: "Stable conversation identifier",
      schema: Schema.String,
    },
    mailbox: {
      description: "Mailbox that observed the thread",
      required: true,
      schema: Schema.String,
    },
    sentAt: {
      description: "Message timestamp in unix epoch milliseconds",
      schema: Schema.Number,
    },
    snippet: {
      description: "Short citation from the message",
      schema: Schema.String,
    },
    subject: { description: "Message subject", schema: Schema.String },
    threadId: {
      description: "Provider thread id or Message-ID",
      required: true,
      schema: Schema.String,
    },
  },
  typology: "observation",
});

export const CompromissoType = defineObjectType({
  description: "Calendar event; private events never enter",
  id: "Compromisso",
  name: "Compromisso",
  primaryKey: "id",
  properties: {
    endsAt: {
      description: "End timestamp in unix epoch milliseconds",
      schema: Schema.Number,
    },
    id: { description: "Stable appointment identifier", schema: Schema.String },
    startsAt: {
      description: "Start timestamp in unix epoch milliseconds",
      schema: Schema.Number,
    },
    title: { description: "Event title", schema: Schema.String },
    uid: {
      description: "iCal UID or provider event id",
      required: true,
      schema: Schema.String,
    },
  },
  typology: "transaction",
});

export const MembroDeLink: LinkType = defineLinkType({
  cardinality: "many-to-many",
  description:
    "Person belongs to an organization derived from a non-public domain",
  id: "membroDe",
  sourceToTargetName: "membroDe",
  sourceTypeId: "Pessoa",
  targetToSourceName: "membros",
  targetTypeId: "Organização",
});

export const ParticipantesLink: LinkType = defineLinkType({
  cardinality: "many-to-many",
  description: "People who participated in a conversation",
  id: "participantes",
  sourceToTargetName: "participantes",
  sourceTypeId: "Conversa",
  targetToSourceName: "conversas",
  targetTypeId: "Pessoa",
});

export const ComLink: LinkType = defineLinkType({
  cardinality: "many-to-many",
  description: "People who attend an appointment",
  id: "com",
  sourceToTargetName: "com",
  sourceTypeId: "Compromisso",
  targetToSourceName: "compromissos",
  targetTypeId: "Pessoa",
});

export const EmLink: LinkType = defineLinkType({
  cardinality: "many-to-many",
  description: "Appointment associated with an organization",
  id: "em",
  sourceToTargetName: "em",
  sourceTypeId: "Compromisso",
  targetToSourceName: "compromissos",
  targetTypeId: "Organização",
});

export const EMAIL_OBJECT_TYPES: readonly ObjectType[] = [
  PessoaType,
  OrganizacaoType,
  ConversaType,
  CompromissoType,
];

export const EMAIL_LINK_TYPES: readonly LinkType[] = [
  MembroDeLink,
  ParticipantesLink,
  ComLink,
  EmLink,
];

export const EMAIL_OBJECT_TYPE_IDS = [
  "Compromisso",
  "Conversa",
  "Organização",
  "Pessoa",
] as const;

export const EMAIL_BOOTSTRAP_CHANGESET: ProposalChangeSet = {
  addedActionTypes: [],
  addedLinkTypes: EMAIL_LINK_TYPES,
  addedObjectTypes: EMAIL_OBJECT_TYPES,
  deletedActionTypeIds: [],
  deletedLinkTypeIds: [],
  deletedObjectTypeIds: [],
  modifiedActionTypes: [],
  modifiedLinkTypes: [],
  modifiedObjectTypes: [],
};
