import type { PublicConfig } from '@sitebot/config'

export type ClientToolHandler = (input: unknown) => unknown | Promise<unknown>
export interface ClientToolOptions {
  config: PublicConfig
  registered: Map<string, ClientToolHandler>
}
export async function runClientTool(
  name: string,
  input: unknown,
  options: ClientToolOptions,
): Promise<unknown> {
  if (!options.config.capabilities.clientTools.includes(name))
    throw new Error(`Client tool "${name}" is not allowed by the server.`)
  const id = options.config.capabilities.clientToolIds?.[name] ?? name
  const handler = options.registered.get(id)
  if (!handler) throw new Error(`No client tool handler registered for "${id}".`)
  const result = await handler(input)
  const encoded = JSON.stringify(result)
  return encoded !== undefined && encoded.length <= 16_384 ? result : { error: 'result_too_large' }
}
export function registerClientTool(
  registered: Map<string, ClientToolHandler>,
  name: string,
  handler: ClientToolHandler,
): void {
  registered.set(name, handler)
}
export function unregisterClientTool(
  registered: Map<string, ClientToolHandler>,
  name: string,
): void {
  registered.delete(name)
}
