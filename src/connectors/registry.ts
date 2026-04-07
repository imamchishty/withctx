import type { SourceConnector } from "./types.js";
import type { SourceType } from "../types/source.js";

/**
 * Registry for source connectors.
 * Connectors are registered by type and looked up by name or type.
 */
export class ConnectorRegistry {
  private connectors: Map<string, SourceConnector> = new Map();

  register(connector: SourceConnector): void {
    this.connectors.set(connector.name, connector);
  }

  get(name: string): SourceConnector | undefined {
    return this.connectors.get(name);
  }

  getByType(type: SourceType): SourceConnector[] {
    return Array.from(this.connectors.values()).filter((c) => c.type === type);
  }

  getAll(): SourceConnector[] {
    return Array.from(this.connectors.values());
  }

  remove(name: string): boolean {
    return this.connectors.delete(name);
  }

  has(name: string): boolean {
    return this.connectors.has(name);
  }

  list(): Array<{ name: string; type: SourceType }> {
    return Array.from(this.connectors.values()).map((c) => ({
      name: c.name,
      type: c.type,
    }));
  }
}
