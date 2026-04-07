import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { TeamsSource } from "../types/config.js";

interface GraphToken {
  access_token: string;
  expires_in: number;
  obtainedAt: number;
}

interface GraphMessage {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime?: string;
  body: { content: string; contentType: string };
  from?: {
    user?: { displayName: string; id: string };
    application?: { displayName: string };
  };
  reactions?: Array<{ reactionType: string }>;
  replies?: GraphMessage[];
  attachments?: Array<{
    id: string;
    contentType: string;
    name?: string;
    contentUrl?: string;
  }>;
  messageType: string;
}

interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

interface GraphTeam {
  id: string;
  displayName: string;
}

interface GraphChannel {
  id: string;
  displayName: string;
}

// Greetings and low-value messages to filter out
const GREETING_PATTERNS = /^(hi|hey|hello|thanks|thank you|thx|ty|ok|okay|sure|np|no problem|lol|haha|yes|no|yep|nope|cool|great|nice|good|k|kk|brb|ttyl|bye|cya|cheers|ta|gg|wb)\s*[!.?]*$/i;
const EMOJI_ONLY = /^[\p{Emoji}\s]+$/u;
const MIN_MESSAGE_LENGTH = 20;

/**
 * Connector for Microsoft Teams.
 * Uses Microsoft Graph API with OAuth2 client credentials flow.
 * Includes noise filtering to skip low-value messages.
 */
export class TeamsConnector implements SourceConnector {
  readonly type = "teams" as const;
  readonly name: string;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private channels: Array<{ team: string; channel: string }>;
  private token: GraphToken | null = null;
  private status: SourceStatus;

  constructor(config: TeamsSource) {
    this.name = config.name;
    this.tenantId = config.tenant_id;
    this.clientId = config.client_id;
    this.clientSecret = config.client_secret;
    this.channels = config.channels;
    this.status = {
      name: config.name,
      type: "teams",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    try {
      await this.getToken();
      // Verify by listing joined teams
      const response = await this.graphGet("/teams");
      if (response.ok) {
        this.status.status = "connected";
        return true;
      }
      this.status.status = "error";
      this.status.error = `Teams API returned HTTP ${response.status}`;
      return false;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to connect to Teams: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      await this.getToken();

      // Resolve team and channel IDs
      const resolvedChannels = await this.resolveChannels();

      for (const { teamId, teamName, channelId, channelName } of resolvedChannels) {
        // Fetch channel messages
        for await (const doc of this.fetchChannelMessages(
          teamId, teamName, channelId, channelName, options
        )) {
          count++;
          yield doc;
          if (options?.limit && count >= options.limit) break;
        }
        if (options?.limit && count >= options.limit) break;

        // Fetch meeting transcripts for the team
        for await (const doc of this.fetchMeetingTranscripts(teamId, teamName, options)) {
          count++;
          yield doc;
          if (options?.limit && count >= options.limit) break;
        }
        if (options?.limit && count >= options.limit) break;
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

  // --- Authentication ---

  private async getToken(): Promise<string> {
    // Return cached token if still valid (with 5 min buffer)
    if (this.token && Date.now() < this.token.obtainedAt + (this.token.expires_in - 300) * 1000) {
      return this.token.access_token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      throw new Error(`OAuth2 token request failed: HTTP ${response.status} — ${await response.text()}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.token = {
      access_token: data.access_token,
      expires_in: data.expires_in,
      obtainedAt: Date.now(),
    };

    return this.token.access_token;
  }

  // --- Channel resolution ---

  private async resolveChannels(): Promise<
    Array<{ teamId: string; teamName: string; channelId: string; channelName: string }>
  > {
    const resolved: Array<{ teamId: string; teamName: string; channelId: string; channelName: string }> = [];

    // Get all teams
    const teamsResponse = await this.graphGet("/teams");
    if (!teamsResponse.ok) {
      throw new Error(`Failed to list teams: HTTP ${teamsResponse.status}`);
    }
    const teamsData = await teamsResponse.json() as GraphListResponse<GraphTeam>;

    for (const channelConfig of this.channels) {
      const team = teamsData.value.find(
        (t) => t.displayName.toLowerCase() === channelConfig.team.toLowerCase()
      );
      if (!team) {
        console.warn(`Team not found: "${channelConfig.team}"`);
        continue;
      }

      const channelsResponse = await this.graphGet(`/teams/${team.id}/channels`);
      if (!channelsResponse.ok) continue;
      const channelsData = await channelsResponse.json() as GraphListResponse<GraphChannel>;

      const channel = channelsData.value.find(
        (c) => c.displayName.toLowerCase() === channelConfig.channel.toLowerCase()
      );
      if (!channel) {
        console.warn(`Channel not found: "${channelConfig.channel}" in team "${channelConfig.team}"`);
        continue;
      }

      resolved.push({
        teamId: team.id,
        teamName: team.displayName,
        channelId: channel.id,
        channelName: channel.displayName,
      });
    }

    return resolved;
  }

  // --- Message fetching ---

  private async *fetchChannelMessages(
    teamId: string,
    teamName: string,
    channelId: string,
    channelName: string,
    options?: FetchOptions
  ): AsyncGenerator<RawDocument> {
    let url = `/teams/${teamId}/channels/${channelId}/messages?$top=50&$expand=replies`;

    // Apply date filter if supported
    if (options?.since) {
      const sinceStr = options.since.toISOString();
      url += `&$filter=lastModifiedDateTime ge ${sinceStr}`;
    }

    let nextLink: string | undefined = url;

    while (nextLink) {
      const response = await this.graphGet(nextLink);
      if (!response.ok) break;

      const data = await response.json() as GraphListResponse<GraphMessage>;

      for (const message of data.value) {
        // Filter noise
        if (this.isNoise(message)) continue;

        const doc = this.messageToDocument(
          message, teamId, teamName, channelId, channelName
        );
        if (doc) yield doc;
      }

      // Handle pagination — the nextLink from Graph is a full URL
      const rawNext = data["@odata.nextLink"];
      if (rawNext) {
        // Extract the path portion from the full URL
        try {
          const nextUrl = new URL(rawNext);
          nextLink = nextUrl.pathname.replace("/v1.0", "") + nextUrl.search;
        } catch {
          nextLink = undefined;
        }
      } else {
        nextLink = undefined;
      }
    }
  }

  // --- Noise filtering ---

  private isNoise(message: GraphMessage): boolean {
    // Skip system/event messages
    if (message.messageType !== "message") return true;

    // Skip bot messages
    if (message.from?.application) return true;

    const text = this.stripHtml(message.body.content).trim();

    // Skip very short messages
    if (text.length < MIN_MESSAGE_LENGTH) return true;

    // Skip emoji-only messages
    if (EMOJI_ONLY.test(text)) return true;

    // Skip greetings
    if (GREETING_PATTERNS.test(text)) return true;

    return false;
  }

  private messageToDocument(
    message: GraphMessage,
    teamId: string,
    teamName: string,
    channelId: string,
    channelName: string
  ): RawDocument | null {
    const text = this.stripHtml(message.body.content).trim();
    if (!text) return null;

    const author = message.from?.user?.displayName || "Unknown";
    const hasReactions = (message.reactions?.length || 0) > 0;
    const replyCount = message.replies?.length || 0;

    // Build content with thread context
    const parts: string[] = [];
    parts.push(`**${author}** (${message.createdDateTime}):`);
    parts.push(text);

    // Mark as decision if it has reactions or replies (signals engagement)
    const isDecision = hasReactions || replyCount > 2;
    if (isDecision) {
      parts.push("");
      parts.push(`[Decision signal: ${message.reactions?.length || 0} reactions, ${replyCount} replies]`);
    }

    // Include replies (filtered for noise)
    if (message.replies && message.replies.length > 0) {
      parts.push("");
      parts.push("**Thread:**");
      for (const reply of message.replies) {
        if (this.isNoise(reply)) continue;
        const replyAuthor = reply.from?.user?.displayName || "Unknown";
        const replyText = this.stripHtml(reply.body.content).trim();
        if (replyText) {
          parts.push(`  ${replyAuthor}: ${replyText}`);
        }
      }
    }

    // Track shared file references
    const fileRefs: string[] = [];
    if (message.attachments) {
      for (const attachment of message.attachments) {
        if (attachment.name) {
          fileRefs.push(attachment.name);
          parts.push(`[Shared file: ${attachment.name}]`);
        }
      }
    }

    return {
      id: `teams:${this.name}:${teamId}:${channelId}:${message.id}`,
      sourceType: "teams",
      sourceName: this.name,
      title: `${teamName} / ${channelName} — ${author} (${message.createdDateTime})`,
      content: parts.join("\n"),
      contentType: "text",
      author,
      createdAt: message.createdDateTime,
      updatedAt: message.lastModifiedDateTime,
      metadata: {
        teamId,
        teamName,
        channelId,
        channelName,
        messageId: message.id,
        replyCount,
        reactionCount: message.reactions?.length || 0,
        isDecision,
        sharedFiles: fileRefs.length > 0 ? fileRefs : undefined,
      },
    };
  }

  // --- Meeting transcripts ---

  private async *fetchMeetingTranscripts(
    teamId: string,
    teamName: string,
    options?: FetchOptions
  ): AsyncGenerator<RawDocument> {
    // List online meetings for the team via calendar events
    // Note: This requires application permission OnlineMeetings.Read.All
    try {
      let url = `/teams/${teamId}/onlineMeetings?$top=20`;

      const response = await this.graphGet(url);
      if (!response.ok) {
        // Meeting transcripts may not be available; silently skip
        return;
      }

      const meetings = await response.json() as GraphListResponse<{
        id: string;
        subject: string;
        startDateTime: string;
        endDateTime: string;
        organizer?: { user?: { displayName: string } };
      }>;

      for (const meeting of meetings.value) {
        // Filter by date if incremental
        if (options?.since && new Date(meeting.startDateTime) < options.since) {
          continue;
        }

        // Try to fetch transcript
        const transcriptResponse = await this.graphGet(
          `/teams/${teamId}/onlineMeetings/${meeting.id}/transcripts`
        );
        if (!transcriptResponse.ok) continue;

        const transcripts = await transcriptResponse.json() as GraphListResponse<{
          id: string;
          createdDateTime: string;
          content?: string;
        }>;

        for (const transcript of transcripts.value) {
          // Fetch actual transcript content
          const contentResponse = await this.graphGet(
            `/teams/${teamId}/onlineMeetings/${meeting.id}/transcripts/${transcript.id}/content?$format=text/vtt`
          );
          if (!contentResponse.ok) continue;

          const vttContent = await contentResponse.text();
          const cleanContent = this.parseVtt(vttContent);

          if (!cleanContent.trim()) continue;

          yield {
            id: `teams:${this.name}:transcript:${meeting.id}:${transcript.id}`,
            sourceType: "teams",
            sourceName: this.name,
            title: `Meeting Transcript: ${meeting.subject || "Untitled"} (${meeting.startDateTime})`,
            content: cleanContent,
            contentType: "text",
            author: meeting.organizer?.user?.displayName,
            createdAt: meeting.startDateTime,
            updatedAt: transcript.createdDateTime,
            metadata: {
              teamId,
              teamName,
              meetingId: meeting.id,
              transcriptId: transcript.id,
              subject: meeting.subject,
              startTime: meeting.startDateTime,
              endTime: meeting.endDateTime,
              docType: "meeting_transcript",
            },
          };
        }
      }
    } catch {
      // Transcript access may not be granted; skip silently
    }
  }

  /**
   * Parse WebVTT transcript format into readable text.
   */
  private parseVtt(vtt: string): string {
    const lines = vtt.split("\n");
    const textLines: string[] = [];
    let currentSpeaker = "";

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip headers and timing lines
      if (trimmed === "WEBVTT" || trimmed === "" || /^\d{2}:\d{2}/.test(trimmed) || /^\d+$/.test(trimmed)) {
        continue;
      }

      // Extract speaker and text: "<v Speaker Name>text</v>"
      const speakerMatch = trimmed.match(/<v ([^>]+)>(.*?)(<\/v>)?$/);
      if (speakerMatch) {
        const speaker = speakerMatch[1];
        const text = speakerMatch[2].replace(/<\/v>$/, "").trim();
        if (speaker !== currentSpeaker) {
          currentSpeaker = speaker;
          textLines.push(`\n**${speaker}:**`);
        }
        if (text) textLines.push(text);
      } else if (trimmed && !trimmed.startsWith("NOTE")) {
        textLines.push(trimmed);
      }
    }

    return textLines.join("\n").trim();
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  private async graphGet(path: string): Promise<Response> {
    const token = await this.getToken();
    const baseUrl = "https://graph.microsoft.com/v1.0";
    const url = path.startsWith("http") ? path : `${baseUrl}${path}`;

    return fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }
}
