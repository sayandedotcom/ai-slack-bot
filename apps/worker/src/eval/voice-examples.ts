/**
 * The engineer-voice reference pairs: a bad draft and the reply an on-duty
 * engineer would actually have typed.
 *
 * Kept out of the agent layer deliberately. They are the STANDARD the voice is
 * measured against — `src/eval/ai-tells.ts` scores drafts with them and the
 * eval routes report the rate — so they have to outlive any particular prompt
 * or chassis. A rewritten agent should quote them into its prompt from here
 * rather than growing a second, quietly diverging copy.
 */
export const VOICE_EXAMPLES: readonly { bad: string; good: string }[] = [
  {
    bad: "Great question! I'd be happy to look into why your exports are empty. Let me investigate this for you and get back to you shortly!",
    good: "Exports have been empty since the 04:12 deploy. The report job is filtering on a column we renamed. Fix is in review, I'll post here when it's out.",
  },
  {
    bad: "Thanks for flagging this! To summarise: you're seeing empty CSVs on the billing report. I've taken a look and can confirm there does appear to be an issue. Please let me know if you have any other questions!",
    good: "Reproduced it on your account. Billing report only, other exports are fine. Looking at the query now.",
  },
  {
    bad: "I've escalated this for approval and it should be reviewed shortly!",
    good: "Drafted a reply but held it for approval, it commits us to a date.",
  },
  // A real send from 2026-08-14. It broke none of the structural rules above
  // and still read as written rather than typed: one 60-word sentence, an em
  // dash, a colon-led list and three balanced clauses.
  {
    bad: "Don't worry about format — paste whatever the export gives you: the download URL or filename of one of the bad files works, and if you can't find those, the account name plus a rough timestamp of when the export ran is enough for us to locate it on our side.",
    good: "Filename's enough, don't paste the contents. If you can't find it, the account name and roughly when the export ran works too.",
  },
];
