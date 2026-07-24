// Copyright 2026 INNO LOTUS PTY LTD
// SPDX-License-Identifier: Apache-2.0

/** A2A protocol version implemented by the Bridge server adapter. */
export const A2aServerProtocol = { Version: "0.2" } as const;

export const A2aTaskState = {
  Completed: "completed",
  Failed: "failed",
} as const;

export interface A2aAgentProvider {
  organization: string;
  url?: string;
}

export interface A2aAgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  stateTransitionHistory: boolean;
}

export interface A2aAgentAuthentication {
  schemes: readonly string[];
  credentials?: string;
}

export interface A2aAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: readonly string[];
  inputModes?: readonly string[];
  outputModes?: readonly string[];
}

export interface A2aAgentCard {
  name: string;
  description?: string;
  url: string;
  provider?: A2aAgentProvider;
  version: string;
  capabilities: A2aAgentCapabilities;
  authentication?: A2aAgentAuthentication;
  defaultInputModes: readonly string[];
  defaultOutputModes: readonly string[];
  skills: readonly A2aAgentSkill[];
}

export interface A2aPart {
  type: string;
  text?: string;
  data?: unknown;
  metadata?: unknown;
}

export interface A2aMessage {
  role: string;
  parts: readonly A2aPart[];
  metadata?: unknown;
}

export interface A2aArtifact {
  name?: string;
  description?: string;
  parts: readonly A2aPart[];
  index: number;
  metadata?: unknown;
}

export interface A2aTaskStatus {
  state: string;
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  sessionId?: string;
  status: A2aTaskStatus;
  artifacts?: readonly A2aArtifact[];
  history?: readonly A2aMessage[];
  metadata?: unknown;
}

export interface A2aSendTaskParams {
  id: string;
  sessionId?: string;
  message: A2aMessage;
  metadata?: unknown;
}
