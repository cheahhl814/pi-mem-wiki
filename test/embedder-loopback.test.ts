import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  resolveEmbedder,
} from "../extensions/llm-wiki/lib/embeddings.js";
import type { TaskConfig } from "../extensions/llm-wiki/lib/task-config.js";

const savedKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

function cfg(overrides: Partial<TaskConfig>): TaskConfig {
  return {
    embeddingProvider: "openai-compatible",
    ...overrides,
  } as TaskConfig;
}

describe("keyless-loopback embedder (fork M1)", () => {
  it("isLoopbackUrl classification", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:11434/v1")).toBe(true);
    expect(isLoopbackUrl("https://api.openai.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.example.com/v1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("loopback base URL with NO api key resolves an embedder (keyless)", () => {
    delete process.env.OPENAI_API_KEY;
    const embedder = resolveEmbedder(
      cfg({ embeddingBaseUrl: "http://localhost:11434/v1", embeddingModel: "bge-m3" }),
    );
    expect(embedder).toBeDefined();
    expect(embedder!.model).toBe("bge-m3");
  });

  it("remote base URL without a key stays undefined (no exemption leak)", () => {
    delete process.env.OPENAI_API_KEY;
    expect(
      resolveEmbedder(cfg({ embeddingBaseUrl: "https://api.openai.com" })),
    ).toBeUndefined();
    // Default base URL is remote too.
    expect(resolveEmbedder(cfg({}))).toBeUndefined();
  });

  it("an explicit key still takes precedence on any host", () => {
    const embedder = resolveEmbedder(
      cfg({
        embeddingBaseUrl: "http://localhost:11434/v1",
        embeddingApiKey: "real-key",
        embeddingModel: "bge-m3",
      }),
    );
    expect(embedder).toBeDefined();
  });
});