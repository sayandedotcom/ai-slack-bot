export type SlackMessageEvent = {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
};

export type SlackEnvelope =
  | { type: "url_verification"; challenge: string }
  | {
      type: "event_callback";
      event_id: string;
      team_id: string;
      event: SlackMessageEvent;
    };

/** What crosses the queue boundary. Kept minimal and serializable. */
export type QueuedEvent = {
  event_id: string;
  event: SlackMessageEvent;
  received_at: number;
};
