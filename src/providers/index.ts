import { codexProvider } from "./openai-codex.ts";
import { openRouterProvider } from "./openrouter.ts";

export { codexProvider, openRouterProvider };

export function getProvider(id: string) {
  if (id === codexProvider.id) return codexProvider;
  if (id === openRouterProvider.id) return openRouterProvider;
  throw new Error(`Unknown provider: ${id}`);
}

export const providers = [codexProvider, openRouterProvider];
