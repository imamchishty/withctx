import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { resilientFetch } from "./resilient-fetch.js";

interface GraphToken {
  access_token: string;
  expires_in: number;
  obtainedAt: number;
}

interface DriveItem {
  id: string;
  name: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  lastModifiedDateTime: string;
  createdDateTime: string;
  size: number;
  webUrl: string;
  "@microsoft.graph.downloadUrl"?: string;
}

interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** File types we can process via existing connectors */
const SUPPORTED_EXTENSIONS = new Set([
  ".docx", ".doc",
  ".xlsx", ".xls", ".csv",
  ".pptx", ".ppt",
  ".pdf",
  ".md", ".txt", ".rst",
]);

/**
 * Connector for Microsoft SharePoint / OneDrive.
 * Uses Microsoft Graph API to fetch documents from SharePoint sites.
 * Downloads files and routes them through existing file-type connectors
 * (Word, Excel, PowerPoint, PDF).
 *
 * Reuses the same Microsoft Graph auth as the Teams connector.
 */
export class SharePointConnector implements SourceConnector {
  readonly type = "sharepoint" as const;
  readonly name: string;
  private siteUrl: string;
  private paths: string[];
  private files: string[];
  private filetypes: string[];
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private token: GraphToken | null = null;
  private cacheDir: string;
  private status: SourceStatus;

  constructor(
    name: string,
    config: {
      site: string;
      paths?: string[];
      files?: string[];
      filetypes?: string[];
    },
    cacheDir: string
  ) {
    this.name = name;
    this.siteUrl = config.site;
    this.paths = config.paths ?? [];
    this.files = config.files ?? [];
    this.filetypes = config.filetypes ?? [".docx", ".xlsx", ".pptx", ".pdf", ".md"];
    this.tenantId = process.env.TEAMS_TENANT_ID ?? "";
    this.clientId = process.env.TEAMS_CLIENT_ID ?? "";
    this.clientSecret = process.env.TEAMS_CLIENT_SECRET ?? "";
    this.cacheDir = join(cacheDir, "sharepoint", name);
    this.status = {
      name,
      type: "sharepoint",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    if (!this.tenantId || !this.clientId || !this.clientSecret) {
      this.status.status = "error";
      this.status.error =
        "Missing Microsoft Graph credentials. Set TEAMS_TENANT_ID, TEAMS_CLIENT_ID, and TEAMS_CLIENT_SECRET.";
      return false;
    }

    try {
      await this.getToken();
      // Test by resolving the site
      await this.getSiteId();
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error =
        error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      const siteId = await this.getSiteId();
      const driveId = await getDefaultDriveId(siteId, await this.getAccessToken());

      // Ensure cache directory exists
      if (!existsSync(this.cacheDir)) {
        mkdirSync(this.cacheDir, { recursive: true });
      }

      // Fetch from specified paths (folders)
      for (const folderPath of this.paths) {
        const items = await this.listFolderItems(driveId, folderPath);

        for (const item of items) {
          if (options?.limit && count >= options.limit) return;
          if (!item.file) continue; // skip folders

          const ext = extname(item.name).toLowerCase();
          if (!this.isSupportedFile(ext)) continue;

          // Incremental: skip files not modified since last sync
          if (options?.since) {
            const modified = new Date(item.lastModifiedDateTime);
            if (modified < options.since) continue;
          }

          const doc = await this.downloadAndProcess(driveId, item, folderPath);
          if (doc) {
            count++;
            yield doc;
          }
        }
      }

      // Fetch specific files by path
      for (const filePath of this.files) {
        if (options?.limit && count >= options.limit) return;

        const item = await this.getFileItem(driveId, filePath);
        if (!item || !item.file) continue;

        if (options?.since) {
          const modified = new Date(item.lastModifiedDateTime);
          if (modified < options.since) continue;
        }

        const doc = await this.downloadAndProcess(driveId, item, filePath);
        if (doc) {
          count++;
          yield doc;
        }
      }

      this.status.status = "connected";
      this.status.lastSyncAt = new Date().toISOString();
      this.status.itemCount = count;
    } catch (error) {
      this.status.status = "error";
      this.status.error =
        error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  // ─── Microsoft Graph Auth (same as Teams connector) ───

  private async getToken(): Promise<GraphToken> {
    if (this.token && Date.now() - this.token.obtainedAt < (this.token.expires_in - 300) * 1000) {
      return this.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await resilientFetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`OAuth2 token request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = {
      access_token: data.access_token,
      expires_in: data.expires_in,
      obtainedAt: Date.now(),
    };

    return this.token;
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.getToken();
    return token.access_token;
  }

  // ─── SharePoint Site Resolution ───

  private async getSiteId(): Promise<string> {
    const accessToken = await this.getAccessToken();

    // Parse site URL: "acme.sharepoint.com/sites/engineering"
    const parts = this.siteUrl.replace(/^https?:\/\//, "").split("/sites/");
    const hostname = parts[0];
    const sitePath = parts[1] ?? "";

    const url = sitePath
      ? `https://graph.microsoft.com/v1.0/sites/${hostname}:/sites/${sitePath}`
      : `https://graph.microsoft.com/v1.0/sites/${hostname}`;

    const response = await resilientFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve SharePoint site '${this.siteUrl}': ${response.status}`);
    }

    const site = await response.json() as { id: string };
    return site.id;
  }

  // ─── Drive Operations ───

  private async listFolderItems(driveId: string, folderPath: string): Promise<DriveItem[]> {
    const accessToken = await this.getAccessToken();
    const allItems: DriveItem[] = [];

    const encodedPath = encodeURIComponent(folderPath.replace(/^\//, "")).replace(/%2F/g, "/");
    let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/children?$top=200`;

    while (url) {
      const response = await resilientFetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return []; // folder doesn't exist, skip
        }
        throw new Error(`Failed to list folder '${folderPath}': ${response.status}`);
      }

      const data = await response.json() as GraphListResponse<DriveItem>;
      allItems.push(...data.value);
      url = data["@odata.nextLink"] ?? "";
    }

    // Recursively fetch subfolders
    const subfolderItems: DriveItem[] = [];
    for (const item of allItems) {
      if (item.folder && item.folder.childCount > 0) {
        const subPath = folderPath.endsWith("/")
          ? `${folderPath}${item.name}`
          : `${folderPath}/${item.name}`;
        const subItems = await this.listFolderItems(driveId, subPath);
        subfolderItems.push(...subItems);
      }
    }

    return [...allItems, ...subfolderItems];
  }

  private async getFileItem(driveId: string, filePath: string): Promise<DriveItem | null> {
    const accessToken = await this.getAccessToken();
    const encodedPath = encodeURIComponent(filePath.replace(/^\//, "")).replace(/%2F/g, "/");
    const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}`;

    const response = await resilientFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to get file '${filePath}': ${response.status}`);
    }

    return await response.json() as DriveItem;
  }

  private async downloadFile(driveId: string, itemId: string): Promise<Buffer> {
    const accessToken = await this.getAccessToken();
    const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`;

    const response = await resilientFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async downloadAndProcess(
    driveId: string,
    item: DriveItem,
    contextPath: string
  ): Promise<RawDocument | null> {
    const ext = extname(item.name).toLowerCase();

    // Download file to cache
    const fileBuffer = await this.downloadFile(driveId, item.id);
    const cachedPath = join(this.cacheDir, item.id + ext);
    writeFileSync(cachedPath, fileBuffer);

    // Extract text content based on file type
    let content: string;
    let contentType: "text" | "code" = "text";
    const images: Array<{ name: string; data: Buffer; mimeType: string }> = [];

    try {
      if (ext === ".docx" || ext === ".doc") {
        content = await this.extractWord(cachedPath);
      } else if (ext === ".xlsx" || ext === ".xls") {
        content = this.extractExcel(cachedPath);
      } else if (ext === ".csv") {
        content = readFileSync(cachedPath, "utf-8");
      } else if (ext === ".pptx" || ext === ".ppt") {
        content = await this.extractPowerPoint(cachedPath);
      } else if (ext === ".pdf") {
        content = await this.extractPdf(cachedPath);
      } else if (ext === ".md" || ext === ".txt" || ext === ".rst") {
        content = readFileSync(cachedPath, "utf-8");
      } else {
        return null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      content = `_Error extracting content from ${item.name}: ${msg}_`;
    }

    if (!content.trim()) return null;

    return {
      id: `sharepoint:${this.name}:${item.id}`,
      sourceType: "sharepoint" as RawDocument["sourceType"],
      sourceName: this.name,
      title: item.name,
      content,
      contentType,
      createdAt: item.createdDateTime,
      updatedAt: item.lastModifiedDateTime,
      images,
      metadata: {
        path: contextPath,
        extension: ext,
        size: item.size,
        webUrl: item.webUrl,
        sharePointItemId: item.id,
      },
    };
  }

  // ─── File Extraction (reuses same libraries as other connectors) ───

  private async extractWord(filePath: string): Promise<string> {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.default.extractRawText({ path: filePath });
      return result.value;
    } catch {
      return readFileSync(filePath, "utf-8");
    }
  }

  private extractExcel(filePath: string): string {
    try {
      const XLSX = require("xlsx");
      const workbook = XLSX.readFile(filePath);
      const sheets: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (data.length === 0) continue;

        let table = `### ${sheetName}\n\n`;
        const headers = data[0].map(String);
        table += `| ${headers.join(" | ")} |\n`;
        table += `| ${headers.map(() => "---").join(" | ")} |\n`;

        for (let i = 1; i < data.length && i < 500; i++) {
          const row = data[i].map(String);
          table += `| ${row.join(" | ")} |\n`;
        }

        sheets.push(table);
      }

      return sheets.join("\n\n");
    } catch {
      return `_Could not parse Excel file: ${basename(filePath)}_`;
    }
  }

  private async extractPowerPoint(filePath: string): Promise<string> {
    try {
      const JSZip = (await import("jszip")).default;
      const data = readFileSync(filePath);
      const zip = await JSZip.loadAsync(data);
      const slides: string[] = [];

      let slideNum = 1;
      while (true) {
        const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`);
        if (!slideFile) break;

        const xml = await slideFile.async("text");
        const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
        const texts = textMatches.map((m) =>
          m.replace(/<a:t>/, "").replace(/<\/a:t>/, "")
        );

        if (texts.length > 0) {
          slides.push(`### Slide ${slideNum}\n\n${texts.join("\n")}`);
        }
        slideNum++;
      }

      return slides.join("\n\n") || `_Empty presentation: ${basename(filePath)}_`;
    } catch {
      return `_Could not parse PowerPoint file: ${basename(filePath)}_`;
    }
  }

  private async extractPdf(filePath: string): Promise<string> {
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const buffer = readFileSync(filePath);
      const result = await pdfParse(buffer);
      return result.text;
    } catch {
      return `_Could not parse PDF file: ${basename(filePath)}_`;
    }
  }

  private isSupportedFile(ext: string): boolean {
    if (this.filetypes.length > 0) {
      const normalized = this.filetypes.map((t) =>
        t.startsWith(".") ? t : `.${t}`
      );
      return normalized.includes(ext);
    }
    return SUPPORTED_EXTENSIONS.has(ext);
  }
}

// ─── Helper ───

async function getDefaultDriveId(
  siteId: string,
  accessToken: string
): Promise<string> {
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`;
  const response = await resilientFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to get default drive for site: ${response.status}`);
  }

  const drive = await response.json() as { id: string };
  return drive.id;
}
