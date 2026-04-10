import type { MockRoute } from "./mock-server.js";

export interface FixtureSlackChannel {
  id: string;
  name: string;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface FixtureSlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

export interface FixtureSlackUser {
  id: string;
  real_name: string;
  name: string;
}

export const SAMPLE_CHANNELS: FixtureSlackChannel[] = [
  {
    id: "C100",
    name: "general",
    topic: { value: "General announcements" },
    purpose: { value: "Team-wide discussion" },
  },
  {
    id: "C200",
    name: "engineering",
    topic: { value: "Engineering chat" },
    purpose: { value: "Technical discussion" },
  },
];

export const SAMPLE_USERS: Record<string, FixtureSlackUser> = {
  U1: { id: "U1", real_name: "Alice Engineer", name: "alice" },
  U2: { id: "U2", real_name: "Bob Manager", name: "bob" },
  U3: { id: "U3", real_name: "Charlie Coder", name: "charlie" },
};

/** 1.6e9 → ~2020, use a fixed baseline so tests are stable. */
const BASE_TS = 1_700_000_000;

/** History keyed by channel id. */
export const SAMPLE_HISTORY: Record<string, FixtureSlackMessage[]> = {
  C100: [
    {
      type: "message",
      user: "U1",
      text: "Welcome everyone to the general channel! This is a placeholder announcement long enough to pass the substantive filter.",
      ts: `${BASE_TS}.000100`,
      thread_ts: `${BASE_TS}.000100`,
      reply_count: 2,
    },
    {
      type: "message",
      user: "U2",
      text: "hi", // noise pattern
      ts: `${BASE_TS}.000200`,
    },
    {
      type: "message",
      subtype: "channel_join",
      user: "U3",
      text: "Charlie has joined the channel",
      ts: `${BASE_TS}.000300`,
    },
    {
      type: "message",
      bot_id: "B100",
      text: "This is a bot message that should be filtered out of the sync entirely.",
      ts: `${BASE_TS}.000400`,
    },
  ],
  C200: [
    {
      type: "message",
      user: "U2",
      text: "Let's discuss the new deployment pipeline architecture proposal and the potential tradeoffs.",
      ts: `${BASE_TS}.000500`,
      thread_ts: `${BASE_TS}.000500`,
      reply_count: 3,
    },
    {
      type: "message",
      user: "U3",
      text: "I think we should also consider the rollback strategy for the new deployment pipeline.",
      ts: `${BASE_TS}.000600`,
    },
  ],
};

/** Thread replies keyed by "<channelId>:<parentTs>". */
export const SAMPLE_REPLIES: Record<string, FixtureSlackMessage[]> = {
  [`C100:${BASE_TS}.000100`]: [
    // First message is always the parent re-echoed; connector strips it via slice(1).
    {
      type: "message",
      user: "U1",
      text: "Welcome everyone to the general channel! This is a placeholder announcement long enough to pass the substantive filter.",
      ts: `${BASE_TS}.000100`,
      thread_ts: `${BASE_TS}.000100`,
    },
    {
      type: "message",
      user: "U2",
      text: "Thanks Alice, looking forward to working together.",
      ts: `${BASE_TS}.000101`,
      thread_ts: `${BASE_TS}.000100`,
    },
    {
      type: "message",
      user: "U3",
      text: "Agreed, excited to be here.",
      ts: `${BASE_TS}.000102`,
      thread_ts: `${BASE_TS}.000100`,
    },
  ],
  [`C200:${BASE_TS}.000500`]: [
    {
      type: "message",
      user: "U2",
      text: "Let's discuss the new deployment pipeline architecture proposal and the potential tradeoffs.",
      ts: `${BASE_TS}.000500`,
      thread_ts: `${BASE_TS}.000500`,
    },
    {
      type: "message",
      user: "U3",
      text: "I vote for the canary approach with gradual rollout.",
      ts: `${BASE_TS}.000501`,
      thread_ts: `${BASE_TS}.000500`,
    },
    {
      type: "message",
      user: "U1",
      text: "Canary makes sense, but we need to sort out observability first.",
      ts: `${BASE_TS}.000502`,
      thread_ts: `${BASE_TS}.000500`,
    },
    {
      type: "message",
      user: "U2",
      text: "Observability is already in progress in another thread.",
      ts: `${BASE_TS}.000503`,
      thread_ts: `${BASE_TS}.000500`,
    },
  ],
};

/** Build Slack mock API routes mounted under /api. */
export function buildSlackRoutes(
  opts: {
    authOk?: boolean;
    channels?: FixtureSlackChannel[];
    history?: Record<string, FixtureSlackMessage[]>;
    replies?: Record<string, FixtureSlackMessage[]>;
    users?: Record<string, FixtureSlackUser>;
  } = {},
): MockRoute[] {
  const authOk = opts.authOk ?? true;
  const channels = opts.channels ?? SAMPLE_CHANNELS;
  const history = opts.history ?? SAMPLE_HISTORY;
  const replies = opts.replies ?? SAMPLE_REPLIES;
  const users = opts.users ?? SAMPLE_USERS;

  return [
    {
      method: "GET",
      path: "/api/auth.test",
      handler: (_req, res) => {
        if (!authOk) {
          res.json({ ok: false, error: "invalid_auth" });
          return;
        }
        res.json({ ok: true, user: "bot", team: "test", url: "https://mock.slack.com/" });
      },
    },
    {
      method: "GET",
      path: "/api/conversations.list",
      handler: (_req, res) => {
        res.json({ ok: true, channels });
      },
    },
    {
      method: "GET",
      path: "/api/conversations.history",
      handler: (req, res) => {
        const channelId = req.query.channel;
        const messages = history[channelId] || [];
        res.json({ ok: true, messages, has_more: false });
      },
    },
    {
      method: "GET",
      path: "/api/conversations.replies",
      handler: (req, res) => {
        const channelId = req.query.channel;
        const ts = req.query.ts;
        const key = `${channelId}:${ts}`;
        const msgs = replies[key] || [];
        res.json({ ok: true, messages: msgs });
      },
    },
    {
      method: "GET",
      path: "/api/users.info",
      handler: (req, res) => {
        const userId = req.query.user;
        const u = users[userId];
        if (!u) {
          res.json({ ok: false, error: "user_not_found" });
          return;
        }
        res.json({ ok: true, user: { real_name: u.real_name, name: u.name } });
      },
    },
  ];
}
