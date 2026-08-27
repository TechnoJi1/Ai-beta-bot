import { GoogleGenAI } from "@google/genai";

export type InterpretedAction = "mine" | "farm" | "guard" | "stop" | "status" | "unknown";

export interface InterpretedCommand {
  action: InterpretedAction;
  blockName?: string;
}

const VALID_ACTIONS: readonly InterpretedAction[] = ["mine", "farm", "guard", "stop", "status", "unknown"];

const SYSTEM_INSTRUCTION = [
  "You translate a Minecraft player's free-form chat message into one of a worker bot's five commands.",
  'Commands: "mine" (optionally targeting a specific block/ore name, e.g. "diamond_ore"), "farm", "guard", "stop", "status".',
  'If the message does not clearly map to one of these five actions, respond with action "unknown".',
  'Only include blockName when the player names a specific block or ore for mining; omit it otherwise.',
  "Respond with JSON only, matching the provided schema — no extra commentary.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...VALID_ACTIONS] },
    blockName: { type: "string" },
  },
  required: ["action"],
} as const;

export class GeminiCommandInterpreter {
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 8_000,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  /**
   * Returns null if the message couldn't be interpreted at all (API error,
   * timeout, malformed response) — the caller treats that the same as
   * "ignore this message" rather than surfacing a raw error to chat.
   */
  async interpret(message: string): Promise<InterpretedCommand | null> {
    const response = await this.withTimeout(
      this.client.models.generateContent({
        model: this.model,
        contents: message,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    );

    const text = response.text;
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }

    return this.validate(parsed);
  }

  private validate(value: unknown): InterpretedCommand | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;

    const action = record.action;
    if (typeof action !== "string" || !VALID_ACTIONS.includes(action as InterpretedAction)) {
      return null;
    }

    const blockName =
      typeof record.blockName === "string" && record.blockName.trim().length > 0
        ? record.blockName.trim()
        : undefined;

    return { action: action as InterpretedAction, blockName };
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Gemini request timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
