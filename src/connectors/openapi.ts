import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { OpenApiSource } from "../types/config.js";

// --- Minimal OpenAPI type definitions ---

interface OpenApiInfo {
  title: string;
  description?: string;
  version: string;
}

interface OpenApiServer {
  url: string;
  description?: string;
}

interface OpenApiParameter {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  schema?: OpenApiSchema;
}

interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  enum?: unknown[];
  $ref?: string;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  example?: unknown;
}

interface OpenApiMediaType {
  schema?: OpenApiSchema;
}

interface OpenApiRequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

interface OpenApiPathItem {
  summary?: string;
  description?: string;
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  trace?: OpenApiOperation;
  parameters?: OpenApiParameter[];
}

interface OpenApiSecurityScheme {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, unknown>;
}

interface OpenApiTag {
  name: string;
  description?: string;
}

interface OpenApiSpec {
  // OpenAPI 3.x
  openapi?: string;
  // Swagger 2.0
  swagger?: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  // Swagger 2.0 fields
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, OpenApiSecurityScheme>;
  };
  // Swagger 2.0 equivalents
  definitions?: Record<string, OpenApiSchema>;
  securityDefinitions?: Record<string, OpenApiSecurityScheme>;
  tags?: OpenApiTag[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"] as const;

/**
 * Connector for OpenAPI/Swagger specification files.
 * Parses OpenAPI 3.x and Swagger 2.0 specs (JSON and YAML)
 * and extracts API documentation as markdown.
 */
export class OpenApiConnector implements SourceConnector {
  readonly type = "openapi" as const;
  readonly name: string;
  private specPath?: string;
  private specUrl?: string;
  private lastModified?: number;
  private status: SourceStatus;

  constructor(config: OpenApiSource) {
    this.name = config.name;
    this.specPath = config.path;
    this.specUrl = config.url;
    this.status = {
      name: config.name,
      type: "openapi",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    try {
      if (this.specPath) {
        const s = await stat(this.specPath);
        if (!s.isFile()) {
          this.status.status = "error";
          this.status.error = `Path is not a file: ${this.specPath}`;
          return false;
        }
      } else if (this.specUrl) {
        const response = await fetch(this.specUrl, { method: "HEAD" });
        if (!response.ok) {
          this.status.status = "error";
          this.status.error = `URL returned HTTP ${response.status}: ${this.specUrl}`;
          return false;
        }
      } else {
        this.status.status = "error";
        this.status.error = "No path or url configured";
        return false;
      }

      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to validate OpenAPI spec: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      // Check incremental: if local file, compare modification time
      if (this.specPath && options?.since) {
        const s = await stat(this.specPath);
        if (s.mtimeMs <= options.since.getTime()) {
          this.status.status = "connected";
          return;
        }
        this.lastModified = s.mtimeMs;
      }

      const spec = await this.loadSpec();

      // 1. Summary / overview document
      count++;
      yield this.buildOverviewDocument(spec);
      if (options?.limit && count >= options.limit) {
        this.status.status = "connected";
        this.status.lastSyncAt = new Date().toISOString();
        this.status.itemCount = count;
        return;
      }

      // 2. Per-tag endpoint documents
      const taggedEndpoints = this.groupEndpointsByTag(spec);
      for (const [tag, endpoints] of Object.entries(taggedEndpoints)) {
        count++;
        yield this.buildTagDocument(spec, tag, endpoints);
        if (options?.limit && count >= options.limit) break;
      }

      // 3. Schema / data models document
      const schemas = spec.components?.schemas || spec.definitions;
      if (schemas && Object.keys(schemas).length > 0) {
        if (!(options?.limit && count >= options.limit)) {
          count++;
          yield this.buildSchemaDocument(spec, schemas);
        }
      }

      this.status.status = "connected";
      this.status.lastSyncAt = new Date().toISOString();
      this.status.itemCount = count;
    } catch (error) {
      this.status.status = "error";
      this.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  // --- Spec loading ---

  private async loadSpec(): Promise<OpenApiSpec> {
    let raw: string;

    if (this.specPath) {
      raw = await readFile(this.specPath, "utf-8");
    } else if (this.specUrl) {
      const response = await fetch(this.specUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch spec from ${this.specUrl}: HTTP ${response.status}`);
      }
      raw = await response.text();
    } else {
      throw new Error("No path or url configured");
    }

    // Try JSON first, fall back to YAML
    try {
      return JSON.parse(raw) as OpenApiSpec;
    } catch {
      return parseYaml(raw) as OpenApiSpec;
    }
  }

  // --- Base URL resolution ---

  private getBaseUrl(spec: OpenApiSpec): string {
    // OpenAPI 3.x
    if (spec.servers && spec.servers.length > 0) {
      return spec.servers[0].url;
    }
    // Swagger 2.0
    if (spec.host) {
      const scheme = spec.schemes?.[0] || "https";
      return `${scheme}://${spec.host}${spec.basePath || ""}`;
    }
    return "(base URL not specified)";
  }

  // --- Auth methods ---

  private getAuthMethods(spec: OpenApiSpec): string[] {
    const schemes = spec.components?.securitySchemes || spec.securityDefinitions;
    if (!schemes) return [];

    const methods: string[] = [];
    for (const [name, scheme] of Object.entries(schemes)) {
      switch (scheme.type) {
        case "apiKey":
          methods.push(`**${name}**: API Key in ${scheme.in} (${scheme.name})`);
          break;
        case "http":
          methods.push(`**${name}**: HTTP ${scheme.scheme}${scheme.bearerFormat ? ` (${scheme.bearerFormat})` : ""}`);
          break;
        case "oauth2":
          methods.push(`**${name}**: OAuth2`);
          break;
        default:
          methods.push(`**${name}**: ${scheme.type}${scheme.description ? ` - ${scheme.description}` : ""}`);
      }
    }
    return methods;
  }

  // --- Overview document ---

  private buildOverviewDocument(spec: OpenApiSpec): RawDocument {
    const parts: string[] = [];
    const specVersion = spec.openapi || spec.swagger || "unknown";

    parts.push(`# ${spec.info.title}`);
    parts.push("");
    parts.push(`**Version:** ${spec.info.version}`);
    parts.push(`**Spec Format:** ${spec.openapi ? "OpenAPI" : "Swagger"} ${specVersion}`);
    parts.push(`**Base URL:** ${this.getBaseUrl(spec)}`);

    if (spec.info.description) {
      parts.push("");
      parts.push(spec.info.description);
    }

    // Authentication
    const authMethods = this.getAuthMethods(spec);
    if (authMethods.length > 0) {
      parts.push("");
      parts.push("## Authentication");
      parts.push("");
      for (const method of authMethods) {
        parts.push(`- ${method}`);
      }
    }

    // Servers (OpenAPI 3.x)
    if (spec.servers && spec.servers.length > 1) {
      parts.push("");
      parts.push("## Servers");
      parts.push("");
      for (const server of spec.servers) {
        parts.push(`- \`${server.url}\`${server.description ? ` - ${server.description}` : ""}`);
      }
    }

    // Tags overview
    if (spec.tags && spec.tags.length > 0) {
      parts.push("");
      parts.push("## API Groups");
      parts.push("");
      for (const tag of spec.tags) {
        parts.push(`- **${tag.name}**${tag.description ? `: ${tag.description}` : ""}`);
      }
    }

    // Endpoint summary
    const allEndpoints = this.getAllEndpoints(spec);
    parts.push("");
    parts.push(`## Endpoints (${allEndpoints.length} total)`);
    parts.push("");
    for (const ep of allEndpoints) {
      parts.push(`- \`${ep.method.toUpperCase()} ${ep.path}\`${ep.operation.summary ? ` - ${ep.operation.summary}` : ""}`);
    }

    return {
      id: `openapi:${this.name}:overview`,
      sourceType: "openapi",
      sourceName: this.name,
      title: `${spec.info.title} - API Overview`,
      content: parts.join("\n"),
      contentType: "text",
      url: this.specUrl,
      metadata: {
        docType: "overview",
        specVersion,
        apiVersion: spec.info.version,
        endpointCount: allEndpoints.length,
        baseUrl: this.getBaseUrl(spec),
      },
    };
  }

  // --- Tag documents ---

  private buildTagDocument(
    spec: OpenApiSpec,
    tag: string,
    endpoints: Array<{ method: string; path: string; operation: OpenApiOperation }>
  ): RawDocument {
    const tagInfo = spec.tags?.find((t) => t.name === tag);
    const parts: string[] = [];

    parts.push(`# ${spec.info.title} - ${tag}`);
    if (tagInfo?.description) {
      parts.push("");
      parts.push(tagInfo.description);
    }
    parts.push("");

    for (const ep of endpoints) {
      parts.push(`## ${ep.method.toUpperCase()} ${ep.path}`);
      parts.push("");

      if (ep.operation.deprecated) {
        parts.push("> **DEPRECATED**");
        parts.push("");
      }

      if (ep.operation.summary) {
        parts.push(`**Summary:** ${ep.operation.summary}`);
        parts.push("");
      }

      if (ep.operation.description) {
        parts.push(ep.operation.description);
        parts.push("");
      }

      // Parameters
      const params = ep.operation.parameters || [];
      if (params.length > 0) {
        parts.push("### Parameters");
        parts.push("");
        parts.push("| Name | In | Required | Type | Description |");
        parts.push("|------|-----|----------|------|-------------|");
        for (const param of params) {
          const type = param.schema?.type || "string";
          const required = param.required ? "Yes" : "No";
          const desc = param.description || "-";
          parts.push(`| \`${param.name}\` | ${param.in} | ${required} | ${type} | ${desc} |`);
        }
        parts.push("");
      }

      // Request body
      if (ep.operation.requestBody) {
        parts.push("### Request Body");
        parts.push("");
        if (ep.operation.requestBody.description) {
          parts.push(ep.operation.requestBody.description);
          parts.push("");
        }
        const content = ep.operation.requestBody.content;
        if (content) {
          for (const [mediaType, mediaObj] of Object.entries(content)) {
            parts.push(`**Content-Type:** \`${mediaType}\``);
            parts.push("");
            if (mediaObj.schema) {
              parts.push("```json");
              parts.push(this.schemaToExample(spec, mediaObj.schema));
              parts.push("```");
              parts.push("");
            }
          }
        }
      }

      // Responses
      if (ep.operation.responses) {
        parts.push("### Responses");
        parts.push("");
        for (const [statusCode, response] of Object.entries(ep.operation.responses)) {
          parts.push(`**${statusCode}:** ${response.description || "-"}`);
          if (response.content) {
            for (const [mediaType, mediaObj] of Object.entries(response.content)) {
              if (mediaObj.schema) {
                parts.push("");
                parts.push(`Content-Type: \`${mediaType}\``);
                parts.push("");
                parts.push("```json");
                parts.push(this.schemaToExample(spec, mediaObj.schema));
                parts.push("```");
              }
            }
          }
          parts.push("");
        }
      }

      // Security
      if (ep.operation.security && ep.operation.security.length > 0) {
        parts.push("### Security");
        parts.push("");
        for (const secReq of ep.operation.security) {
          for (const [scheme, scopes] of Object.entries(secReq)) {
            parts.push(`- **${scheme}**${scopes.length > 0 ? ` (scopes: ${scopes.join(", ")})` : ""}`);
          }
        }
        parts.push("");
      }

      parts.push("---");
      parts.push("");
    }

    return {
      id: `openapi:${this.name}:tag:${tag}`,
      sourceType: "openapi",
      sourceName: this.name,
      title: `${spec.info.title} - ${tag} Endpoints`,
      content: parts.join("\n"),
      contentType: "text",
      url: this.specUrl,
      metadata: {
        docType: "tag",
        tag,
        endpointCount: endpoints.length,
      },
    };
  }

  // --- Schema document ---

  private buildSchemaDocument(
    spec: OpenApiSpec,
    schemas: Record<string, OpenApiSchema>
  ): RawDocument {
    const parts: string[] = [];
    parts.push(`# ${spec.info.title} - Data Models`);
    parts.push("");

    for (const [name, schema] of Object.entries(schemas)) {
      parts.push(`## ${name}`);
      parts.push("");

      if (schema.description) {
        parts.push(schema.description);
        parts.push("");
      }

      if (schema.type) {
        parts.push(`**Type:** ${schema.type}`);
        parts.push("");
      }

      if (schema.enum) {
        parts.push(`**Enum values:** ${schema.enum.map((v) => `\`${String(v)}\``).join(", ")}`);
        parts.push("");
      }

      if (schema.properties) {
        parts.push("| Property | Type | Required | Description |");
        parts.push("|----------|------|----------|-------------|");
        const required = new Set(schema.required || []);
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          const type = this.resolveTypeName(spec, propSchema);
          const isRequired = required.has(propName) ? "Yes" : "No";
          const desc = propSchema.description || "-";
          parts.push(`| \`${propName}\` | ${type} | ${isRequired} | ${desc} |`);
        }
        parts.push("");
      }

      // Example JSON
      parts.push("**Example:**");
      parts.push("");
      parts.push("```json");
      parts.push(this.schemaToExample(spec, schema));
      parts.push("```");
      parts.push("");
      parts.push("---");
      parts.push("");
    }

    return {
      id: `openapi:${this.name}:schemas`,
      sourceType: "openapi",
      sourceName: this.name,
      title: `${spec.info.title} - Data Models`,
      content: parts.join("\n"),
      contentType: "text",
      url: this.specUrl,
      metadata: {
        docType: "schemas",
        schemaCount: Object.keys(schemas).length,
      },
    };
  }

  // --- Helpers ---

  private getAllEndpoints(
    spec: OpenApiSpec
  ): Array<{ method: string; path: string; operation: OpenApiOperation }> {
    const endpoints: Array<{ method: string; path: string; operation: OpenApiOperation }> = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (operation) {
          endpoints.push({ method, path, operation });
        }
      }
    }
    return endpoints;
  }

  private groupEndpointsByTag(
    spec: OpenApiSpec
  ): Record<string, Array<{ method: string; path: string; operation: OpenApiOperation }>> {
    const groups: Record<string, Array<{ method: string; path: string; operation: OpenApiOperation }>> = {};

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;

        const tags = operation.tags && operation.tags.length > 0 ? operation.tags : ["Untagged"];
        for (const tag of tags) {
          if (!groups[tag]) groups[tag] = [];
          groups[tag].push({ method, path, operation });
        }
      }
    }

    return groups;
  }

  private resolveTypeName(spec: OpenApiSpec, schema: OpenApiSchema): string {
    if (schema.$ref) {
      const refName = schema.$ref.split("/").pop() || "object";
      return refName;
    }
    if (schema.type === "array" && schema.items) {
      return `${this.resolveTypeName(spec, schema.items)}[]`;
    }
    if (schema.allOf) return "allOf(...)";
    if (schema.oneOf) return "oneOf(...)";
    if (schema.anyOf) return "anyOf(...)";
    return schema.type || "object";
  }

  /**
   * Generate a JSON example from a schema.
   * Resolves $ref references and builds nested examples.
   */
  private schemaToExample(spec: OpenApiSpec, schema: OpenApiSchema, depth = 0): string {
    if (depth > 4) return '"..."';

    const resolved = this.resolveRef(spec, schema);
    if (!resolved) return "{}";

    if (resolved.example !== undefined) {
      return JSON.stringify(resolved.example, null, 2);
    }

    switch (resolved.type) {
      case "string":
        if (resolved.enum) return JSON.stringify(resolved.enum[0]);
        if (resolved.format === "date-time") return '"2024-01-01T00:00:00Z"';
        if (resolved.format === "date") return '"2024-01-01"';
        if (resolved.format === "email") return '"user@example.com"';
        if (resolved.format === "uri" || resolved.format === "url") return '"https://example.com"';
        if (resolved.format === "uuid") return '"550e8400-e29b-41d4-a716-446655440000"';
        return '"string"';
      case "integer":
      case "number":
        return "0";
      case "boolean":
        return "true";
      case "array": {
        if (resolved.items) {
          const itemExample = this.schemaToExample(spec, resolved.items, depth + 1);
          return `[${itemExample}]`;
        }
        return "[]";
      }
      case "object":
      default: {
        if (!resolved.properties) return "{}";
        const entries: string[] = [];
        for (const [key, propSchema] of Object.entries(resolved.properties)) {
          const val = this.schemaToExample(spec, propSchema, depth + 1);
          entries.push(`  "${key}": ${val}`);
        }
        return `{\n${entries.join(",\n")}\n}`;
      }
    }
  }

  private resolveRef(spec: OpenApiSpec, schema: OpenApiSchema): OpenApiSchema | null {
    if (!schema.$ref) return schema;

    // Handle #/components/schemas/Name and #/definitions/Name
    const parts = schema.$ref.split("/");
    const name = parts.pop();
    if (!name) return null;

    const schemas = spec.components?.schemas || spec.definitions;
    return schemas?.[name] || null;
  }
}
