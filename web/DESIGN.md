# trace-wallet: design

## World

A silver studio, like a printed statement. The ground is light silver. Deep aubergine and marigold are the only accents.

Surfaces follow Certus: paper and ink, hairline rules, near-square corners (2–3px), and uppercase mono labels.

The landing page is a film you scroll through, after everest.suraj.work. A fixed three.js stage sits behind the page and chapters slide over it in frosted panels.

## Colour carries meaning

| Token | Means |
|---|---|
| `--aub` | The wallet holding: refused, held, proven track, primary structure |
| `--mari` / `--mari-deep` | A bound or a decision: exploration track, caps, `decide` buttons, focus. `--mari-deep` is the text-safe variant |
| `--loss` | Money that left |
| `--ink`, `--ink-dim`, `--ink-faint` | Text, tinted toward aubergine |
| `--ground*`, `--panel`, `--panel-glass` | Silver ground and paper panes |
| `--rule`, `--rule-strong` | Hairlines |

Never use marigold as decoration. Never use red unless funds left.

## Type

- **Sans:** Helvetica Neue, falling back to Inter Tight, then Helvetica and Arial. Inter Tight comes before Helvetica because Windows maps Helvetica to Arial.
- **Display:** weight 200–300 with tight tracking. The italic sub-line is marigold-deep (landing) or aubergine (panel titles).
- **Mono labels:** 10.5–11px, uppercase, 0.13–0.15em tracking.
- **Figures:** tabular numerals.

## Components (src/components)

- **Buttons:**
  - `primary`: ink, hovering to aubergine
  - `decide`: marigold, used only for the one action that moves money or starts the demo
  - `secondary`: outlined
  - `ghost`
- **`.panel`:** solid paper. **`.sheet`:** frosted glass, used only over the 3D stage or the backdrop.
- **Navbar:** a floating frosted pane. On hover, the link text thickens from the left (a clip-path reveal) and a gradient underline draws in.
- **Tiles:** grids with 1px gaps (the rule colour shows through). Badges are mono pills on tinted grounds.
- **Gauges:** animate with `transform: scaleX`, never width.

## Landing film (src/surfaces/landing)

- `stage.ts` sets a camera shot and a mode for each chapter (`MODES` in Landing.tsx).
- Request tokens are instanced. Hostile ones turn aubergine and stop at the door; bounded ones ride the marigold track.
- The instrument strip tallies recorded results only after the story has covered them. It hides in the epilogue.
- Under reduced motion, the stage renders still frames and the intro is skipped.
- Below 900px, the floating chapter marks and the rail are hidden, and panels sit in normal flow.

## Motion (framer-motion 12, `MotionConfig reducedMotion="user"` at the root)

- **Easing:** `[0.22, 0.61, 0.36, 1]`. Only transforms and opacity are animated; never width or height.
- **Landing chapter panels:** fade and move with the scroll itself, rising in and drifting out. Their contents stagger in once, and plain numbers count up from zero.
- **Floating chapter marks:** react to scroll position without re-rendering React on every frame. The numeral and the title move at different speeds and blur as they leave.
- **Demo scenarios:** a request marker travels along each wallet's lane to the check point. It stops there if refused, or passes through to the far end if the money is lost or capped (a capped marker shrinks). The TRACE switch replays only the trace-wallet lane.

## Bans

- No dark theme.
- No thick coloured side stripes.
- No gradient text.
- No radius above 3px on panes.
- No fixture or mock data in shipped code.
