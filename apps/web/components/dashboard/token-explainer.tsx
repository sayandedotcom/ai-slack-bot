import { Card, CardContent } from "@workspace/ui/components/card";
import { Bell, UserRound } from "lucide-react";

/**
 * Static documentation, and it earns its place: everything else on this page is
 * unreadable until you know that one Slack app holds two tokens with two
 * completely different jobs. Without it, "the agent replied as Luka" and "the
 * Firefighter bot DM'd me" look like a contradiction.
 */
const TOKENS = [
  {
    icon: UserRound,
    title: "User tokens speak to customers",
    body: "Each fire-fighter authorises once. An approved reply is posted with that person's own token, so it lands in the thread as them — customers are talking to a teammate, not to a bot.",
  },
  {
    icon: Bell,
    title: "The bot token only nudges the team",
    body: "Same app, different token. It DMs a preview and a dashboard link, and it never speaks to a customer and never carries a button. Approval happens here, on one surface.",
  },
];

export function TokenExplainer() {
  return (
    <section aria-labelledby="tokens-heading" className="space-y-3">
      <h2 id="tokens-heading" className="eyebrow">
        One Slack app, two tokens
      </h2>
      <div className="grid gap-3">
        {TOKENS.map((token) => (
          <Card key={token.title}>
            <CardContent className="flex items-start gap-3">
              <token.icon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="space-y-1">
                <p className="font-medium text-sm">{token.title}</p>
                <p className="text-pretty text-muted-foreground text-sm">
                  {token.body}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-pretty text-muted-foreground text-xs">
        A self-DM sent with your own token won&apos;t push-notify you — Slack
        doesn&apos;t alert you about your own messages. The bot token exists
        because it is the one reliable pinger the team already lives in.
      </p>
    </section>
  );
}
