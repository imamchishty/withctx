export type EntityType =
  | "service"
  | "repo"
  | "person"
  | "ticket"
  | "decision"
  | "document"
  | "team"
  | "component"
  | "api";

export type RelationshipType =
  | "owns"
  | "depends-on"
  | "authored"
  | "assigned-to"
  | "references"
  | "decided-in"
  | "documented-in"
  | "part-of"
  | "reviewed-by"
  | "calls";

export interface Entity {
  name: string;
  type: EntityType;
  description?: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface Relationship {
  from: string;
  to: string;
  type: RelationshipType;
  source: string;
}
