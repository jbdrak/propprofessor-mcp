# Sharp-Money Alert — Manual Only

> **SSB is manual-only.** Automated cron, scheduled polling, and
> unattended SSB endpoint calls are not supported. This document
> previously held an executable cron prompt template; it has been replaced
> with this safety notice.

To check for sharp plays on demand, use the `sharp_alerts` tool from
the `ssb-coach` skill. It is deduped, on-demand, and does not
create autonomous schedules.

No Hermes cron, GitHub schedule, launch agent, or recurring job should
call SSB endpoints.
