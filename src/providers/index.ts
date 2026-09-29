import { codexProvider } from "./openai-codex.ts";
import { openRouterProvider } from "./openrouter.ts";
import { anthropicProvider } from "./anthropic.ts";

export { codexProvider, openRouterProvider, anthropicProvider };

export function getProvider(id: string) {
  if (id === codexProvider.id) return codexProvider;
  if (id === openRouterProvider.id) return openRouterProvider;
  if (id === anthropicProvider.id) return anthropicProvider;
  throw new Error(`Unknown provider: ${id}`);
}

export const providers = [codexProvider, openRouterProvider, anthropicProvider];
