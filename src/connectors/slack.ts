import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { SlackSource } from "../types/config.js";
import { resilientFetch } from "./resilient-fetch.js";

interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

interface SlackChannel { id: string; name: string; topic?: { value: string }; purpose?: { value: string }; }

interface SlackConversationsResponse { ok: boolean; channels: SlackChannel[]; error?: string; }
interface SlackHistoryResponse { ok: boolean; messages: SlackMessage[]; has_more: boolean; response_metadata?: { next_cursor: string }; error?: string; }
interface SlackRepliesResponse { ok: boolean; messages: SlackMessage[]; error?: string; }
interface SlackUserResponse { ok: boolean; user?: { real_name: string; name: string }; error?: string; }

const SLACK_API = "https://slack.com/api";

const NOISE_PATTERNS = [
  /^(hi|hello|hey|morning|thanks|thank you|ty|thx|ok|okay|sure|yes|no|yep|nope)\s*$/i,
  /has joined the channel/, /has left the channel/, /set the channel topic/,
];
const MIN_LENGTH = 30;
const MIN_REPLIES = 2;

export class SlackConnector implements SourceConnector {
  readonly type = "slack" as const;
  readonly name: string;
  private token: string;
  private channelNames: string[];
  private since?: string;
  private status: SourceStatus;
  private userCache = new Map<string, string>();

  constructor(config: SlackSource) {
    this.name = config.name;
    this.token = config.token || process.env.SLACK_TOKEN || "";
    this.channelNames = config.channels;
    this.since = config.since;
    this.status = { name: config.name, type: "slack", status: "disconnected" };
  }

  async validate(): Promise<boolean> {
    if (!this.token) {
      this.status.status = "error";
      this.status.error = "No Slack token. Set SLACK_TOKEN or add token to ctx.yaml.";
      return false;
    }
    try {
      const data = await this.slackApi("auth.test");
      if (!data.ok) { this.status.status = "error"; this.status.error = `Slack auth failed`; return false; }
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Cannot reach Slack: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;
    try {
      const channels = await this.resolveChannels();
      for (const channel of channels) {
        if (options?.limit && count >= options.limit) break;
        const oldest = this.getOldestTs(options?.since);
        const messages = await this.fetchHistory(channel.id, oldest);
        const substantive = messages.filter((m) => this.isSubstantive(m));
        if (substantive.length === 0) continue;

        // Thread documents
        const threads = substantive.filter((m) => m.reply_count && m.reply_count >= MIN_REPLIES);
        for (const parent of threads) {
          if (options?.limit && count >= options.limit) break;
          const replies = await this.fetchReplies(channel.id, parent.ts);
          const doc = await this.threadDoc(channel, parent, replies);
          count++; yield doc;
        }

        // Channel summary
        if (!(options?.limit && count >= options.limit)) {
          const doc = await this.summaryDoc(channel, substantive, threads);
          count++; yield doc;
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

  getStatus(): SourceStatus { return { ...this.status }; }

  private async slackApi(method: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${SLACK_API}/${method}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await resilientFetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    }, { rateLimitHeader: "retry-after" });
    if (!response.ok) throw new Error(`Slack API ${method} returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private async resolveChannels(): Promise<SlackChannel[]> {
    const data = (await this.slackApi("conversations.list", { types: "public_channel,private_channel", limit: "1000" })) as unknown as SlackConversationsResponse;
    if (!data.ok) throw new Error(`Failed to list channels: ${data.error}`);
    const nameSet = new Set(this.channelNames.map((n) => n.replace(/^#/, "")));
    return data.channels.filter((ch) => nameSet.has(ch.name));
  }

  private async fetchHistory(channelId: string, oldest?: string): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = { channel: channelId, limit: "200" };
      if (oldest) params.oldest = oldest;
      if (cursor) params.cursor = cursor;
      const data = (await this.slackApi("conversations.history", params)) as unknown as SlackHistoryResponse;
      if (!data.ok) throw new Error(`History failed: ${data.error}`);
      messages.push(...data.messages);
      cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
    } while (cursor);
    return messages;
  }

  private async fetchReplies(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const data = (await this.slackApi("conversations.replies", { channel: channelId, ts: threadTs })) as unknown as SlackRepliesResponse;
    if (!data.ok) return [];
    return data.messages.slice(1);
  }

  private async resolveUser(userId: string): Promise<string> {
    if (this.userCache.has(userId)) return this.userCache.get(userId)!;
    try {
      const data = (await this.slackApi("users.info", { user: userId })) as unknown as SlackUserResponse;
      const name = data.ok ? (data.user?.real_name || data.user?.name || userId) : userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  private isSubstantive(m: SlackMessage): boolean {
    if (m.bot_id || m.subtype) return false;
    for (const p of NOISE_PATTERNS) { if (p.test(m.text)) return false; }
    if (m.text.length < MIN_LENGTH && !m.thread_ts && !m.reply_count) return false;
    return true;
  }

  private getOldestTs(since?: Date): string | undefined {
    if (since) return String(since.getTime() / 1000);
    if (this.since) {
      const match = this.since.match(/^(\d+)([dhw])$/);
      if (match) {
        const ms: Record<string, number> = { d: 86400000, h: 3600000, w: 604800000 };
        return String((Date.now() - parseInt(match[1]) * (ms[match[2]] || 86400000)) / 1000);
      }
    }
    return String((Date.now() - 30 * 86400000) / 1000);
  }

  private async threadDoc(channel: SlackChannel, parent: SlackMessage, replies: SlackMessage[]): Promise<RawDocument> {
    const date = new Date(parseFloat(parent.ts) * 1000);
    const author = parent.user ? await this.resolveUser(parent.user) : "Unknown";
    const parts = [
      `# Thread: ${parent.text.slice(0, 80)}`, "",
      `**Channel:** #${channel.name}`, `**Started by:** ${author}`,
      `**Date:** ${date.toISOString().split("T")[0]}`, `**Replies:** ${replies.length}`, "", "---", "",
      `**${author}:** ${parent.text}`, "",
    ];
    for (const r of replies) {
      const rAuthor = r.user ? await this.resolveUser(r.user) : "Unknown";
      parts.push(`**${rAuthor}:** ${r.text}`, "");
    }
    return {
      id: `slack:${this.name}:${channel.name}:thread:${parent.ts}`,
      sourceType: "slack", sourceName: this.name,
      title: `#${channel.name} — ${parent.text.slice(0, 60)}`,
      content: parts.join("\n"), contentType: "text",
      createdAt: date.toISOString(),
      metadata: { channelName: channel.name, channelId: channel.id, threadTs: parent.ts, replyCount: replies.length },
    };
  }

  private async summaryDoc(channel: SlackChannel, messages: SlackMessage[], threads: SlackMessage[]): Promise<RawDocument> {
    const parts = [
      `# Slack Channel: #${channel.name}`, "",
      channel.topic?.value ? `**Topic:** ${channel.topic.value}` : "",
      channel.purpose?.value ? `**Purpose:** ${channel.purpose.value}` : "",
      `**Messages:** ${messages.length}`, `**Threads:** ${threads.length}`, "",
    ].filter(Boolean);
    if (threads.length > 0) {
      parts.push("## Key Discussions", "");
      const sorted = [...threads].sort((a, b) => (b.reply_count || 0) - (a.reply_count || 0));
      for (const t of sorted.slice(0, 10)) {
        const d = new Date(parseFloat(t.ts) * 1000);
        parts.push(`- **${d.toISOString().split("T")[0]}** (${t.reply_count || 0} replies): ${t.text.slice(0, 100)}`);
      }
    }
    return {
      id: `slack:${this.name}:${channel.name}:summary`,
      sourceType: "slack", sourceName: this.name,
      title: `Slack #${channel.name} — Summary`,
      content: parts.join("\n"), contentType: "text",
      metadata: { channelName: channel.name, channelId: channel.id, messageCount: messages.length, threadCount: threads.length },
    };
  }
}
