import { createHash } from "node:crypto";
import type { ContextBudget } from "./ContextBudget.js";

export type ConversationRole = "assistant" | "system" | "tool" | "user";

export interface ConversationMessage {
  readonly role: ConversationRole;
  readonly content: string;
  readonly critical?: boolean;
}

export interface ModelMessage {
  readonly role: "assistant" | "system" | "user";
  readonly content: string;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class ConversationState {
  private readonly messages: ConversationMessage[] = [];
  private readonly seenContent = new Map<string, number>();

  public append(message: ConversationMessage): void {
    const hash = digest(message.content);
    const previous = this.seenContent.get(hash);
    if (previous !== undefined && message.role === "tool") {
      this.messages.push({
        role: "tool",
        content: `[DUPLICATE TOOL RESULT: content ${hash} first appeared at message ${previous}]`,
        ...(message.critical === true ? { critical: true } : {}),
      });
      return;
    }
    this.seenContent.set(hash, this.messages.length);
    this.messages.push(message);
  }

  public snapshot(): readonly ConversationMessage[] {
    return [...this.messages];
  }

  public toModelMessages(budget: ContextBudget): readonly ModelMessage[] {
    const selected = new Map<number, ModelMessage>();
    const anchors = this.#anchorIndexes();
    let remaining = budget.inputTokenLimit;

    for (const [anchorOffset, index] of anchors.entries()) {
      const message = this.messages[index];
      if (message === undefined) continue;
      const anchorsRemaining = anchors.length - anchorOffset;
      const allocation = Math.floor(remaining / anchorsRemaining);
      if (allocation < 32) {
        throw new Error("Context budget cannot retain required system, task, and error anchors");
      }
      const fitted = budget.fit(this.#modelContent(message), allocation);
      remaining -= fitted.estimatedTokens;
      selected.set(index, { role: this.#modelRole(message), content: fitted.text });
    }

    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message === undefined || selected.has(index) || remaining < 32) continue;
      const fitted = budget.fit(this.#modelContent(message), remaining);
      remaining -= fitted.estimatedTokens;
      selected.set(index, { role: this.#modelRole(message), content: fitted.text });
      if (fitted.truncated || remaining < 32) break;
    }

    return [...selected.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, message]) => message);
  }

  #anchorIndexes(): readonly number[] {
    const anchors = new Set<number>();
    for (const [index, message] of this.messages.entries()) {
      if (message.role === "system") anchors.add(index);
    }
    const critical = this.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.critical === true && message.role !== "system")
      .map(({ index }) => index);
    const firstCritical = critical[0];
    const latestCritical = critical.at(-1);
    if (firstCritical !== undefined) anchors.add(firstCritical);
    if (latestCritical !== undefined) anchors.add(latestCritical);
    return [...anchors].sort((left, right) => left - right);
  }

  #modelContent(message: ConversationMessage): string {
    return message.role === "tool" ? `TOOL RESULT\n${message.content}` : message.content;
  }

  #modelRole(message: ConversationMessage): ModelMessage["role"] {
    return message.role === "tool" ? "user" : message.role;
  }
}
