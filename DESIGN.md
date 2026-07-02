# Crazay Arkade Design System

## 1. Atmosphere & Identity

Crazay Arkade feels like a compact Korean arcade lobby wrapped around a fast tile game: bright, playful, and dense enough that players can create a room, pick a mode, choose a character, and start without leaving the first screen. The signature is dark blue/cyan glass: translucent panels over a blue gradient, neon cyan primary actions, golden selected states, and small rounded game-control surfaces.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/page | --surface-page | #1e3c72 | #2a5298 | Body gradient endpoints |
| Surface/glass | --surface-glass | rgba(255, 255, 255, 0.10) | rgba(255, 255, 255, 0.12) | Login, lobby, room panels and list cells |
| Surface/game-panel | --surface-game-panel | #16276b | #0d1b4f | Sidebar and bottom-bar gradients |
| Surface/game-well | --surface-game-well | #060e2e | #060e2e | Timer, item wells, compact slots |
| Text/primary | --text-primary | #ffffff | #ffffff | Main UI text |
| Text/muted | --text-muted | rgba(255, 255, 255, 0.80) | rgba(255, 255, 255, 0.60) | Subtitles, labels, empty states |
| Text/dark | --text-dark | #222222 | #222222 | Text inputs |
| Border/glass | --border-glass | rgba(255, 255, 255, 0.20) | rgba(110, 150, 255, 0.40) | Panel and game-panel borders |
| Accent/primary | --accent-primary | #36d1dc | #5b86e5 | Primary buttons and side buttons |
| Accent/focus | --accent-focus | #5ec6ff | #5ec6ff | Input and button focus rings |
| Accent/cyan | --accent-cyan | #7df9ff | #80deea | Timers, stat bars, guide emphasis |
| Accent/selected | --accent-selected | #ffd54f | #ffd54f | Selected controls, host badges, counts |
| Team/red | --team-red | #ff5252 | #ff5252 | Red team borders and controls |
| Team/blue | --team-blue | #448aff | #448aff | Blue team borders and controls |
| Status/error | --status-error | #e53935 | #ff6b6b | Toasts, urgent timer, destructive emphasis |

### Rules

- Keep room and game UI on the existing dark blue/cyan glass palette.
- Use gold only for selected, host, or important count states; do not use it as a broad decoration.
- Team red and blue remain reserved for team identity.
- New colors must be added here before use.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| H1 | 30px | 700 | 1.2 | 0 | Login title |
| H2 | 24px | 700 | 1.25 | 0 | Lobby and room titles |
| H3 | 14px | 700 | 1.35 | 0 | Guide and compact panel headings |
| Body | 16px | 700 | 1.4 | 0 | Buttons and primary controls |
| Body/sm | 13px | 700 | 1.35 | 0 | Room slots and room metadata |
| Caption | 11px | 700-800 | 1.25 | 0-1px | Badges, labels, compact stats |
| Mono/numeric | 21px | 700 | 1 | 0 | Timer digits |

### Font Stack

- Primary: `'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif`
- Mono: `'Menlo', 'Consolas', monospace`

### Rules

- Keep Korean labels short and scannable.
- Game-adjacent numbers use the mono stack or tabular-feeling compact labels.
- Avoid viewport-scaled type; compact panels must not overflow on narrow screens.

## 4. Spacing & Layout

### Base Unit

Spacing follows a 4px base unit, with existing compact deviations documented rather than normalized away.

| Token | Value | Usage |
|-------|-------|-------|
| --space-1 | 4px | Icon and inline stat gaps |
| --space-2 | 8px | Button groups, slot grids, compact gaps |
| --space-3 | 12px | Field padding, sidebar padding, room action spacing |
| --space-4 | 16px | List item padding, panel inner grouping |
| --space-5 | 20px | Screen and game-column gaps |
| --space-6 | 24px | Main panel padding |
| --space-8 | 32px | Wide panel viewport inset fallback |

### Grid

- Main game canvas: 600px by 520px, scales down to `calc(100vw - 32px)` below 980px.
- Room panel: `min(1180px, calc(100vw - 32px))` for the arcade waiting-room console; legacy modal panels remain `min(620px, calc(100vw - 32px))`.
- Waiting-room console: 2 columns (`minmax(0, 1.45fr) minmax(300px, 0.85fr)`) on desktop, stacked below 920px.
- Room slots and character picker: room slots use 4 columns on desktop, 2 columns below 640px; character swatches use 4 columns on desktop, 2 columns below 560px.
- Map picker: 2 columns; boss mode collapses to the boss-only map.

### Rules

- Keep room controls compact and visible without long explanatory copy.
- Prevent horizontal overflow on mobile; text must truncate, wrap, or split before it forces scroll.
- Do not put UI cards inside cards. The room panel may contain repeated slots and controls, not nested decorative cards.

## 5. Components

### Glass Panel
- **Structure**: `.panel` or `.panel.wide` inside a `.screen`.
- **Variants**: standard 360px, wide 620px constrained to viewport.
- **Spacing**: 24px padding, 20px screen padding.
- **States**: active screen toggles via `.screen.active`.
- **Depth**: translucent background, blur, 1px light border, 20px radius, broad dark shadow.

### Compact Button
- **Structure**: `button` with role class such as `.btn-primary`, `.btn-secondary`, `.btn-mode`, `.btn-team`, `.btn-side`.
- **Variants**: primary cyan gradient, secondary glass, mode segmented, team red/blue, danger blue-violet.
- **Spacing**: 12px 24px default, smaller 8-9px variants in game panels.
- **States**: hover brightness and translateY(-1px), active translateY(1px), selected gold border/background, disabled opacity.
- **Accessibility**: visible focus ring required on new interactive elements.

### Room Slot
- **Structure**: `.player-slot` inside `#player-list`.
- **Variants**: filled, empty, red team, blue team, host badge, AI badge, ready state.
- **Spacing**: 10px 8px padding, 8px grid gap.
- **Depth**: bright cyan slot cell with 10px radius, dark caption strip, optional 5px left identity border, and avatar canvas for filled players.

### Waiting Room Console
- **Structure**: `.room-console` inside `#screen-room .panel.wide`, with `.room-main` for players/chat and `.room-side` for character/color/map/ready controls.
- **Variants**: responsive stacked console below 920px, compact two-column slots below 640px.
- **Depth**: blue game-panel surfaces with inset cyan highlights and dark wells; no pasted screenshots or fake raster UI.

### Spectator Strip
- **Structure**: `.spectator-panel` containing `.spectator-head`, `.spectator-list`, and `.spectator-chip`.
- **Variants**: empty, filled, host badge, mobile stacked action.
- **Spacing**: 8px internal gaps, 10px padding, chips at 6px 8px.
- **Depth**: light glass strip with 8px radius, visually quieter than player slots.

### Game Player Card
- **Structure**: `.p-card` with avatar canvas, `.p-info`, `.p-name`, `.p-stats`, `.p-status`.
- **Variants**: self, red team, blue team, dead, AI-controlled.
- **Spacing**: 5px 8px padding, 7px column gap.
- **Depth**: dark glass card with 2px blue border and 10px radius.

### In-Game Policy Drawer
- **Structure**: `details.in-game-policy` in the game sidebar, never in the waiting room.
- **Variants**: hidden when no AI is in the match, collapsed summary, expanded policy list.
- **Spacing**: 8px padding, 6px list gaps, 190px max expanded list height.
- **Depth**: dark compact sidebar panel; quieter than player cards and item panels.
- **Live feedback**: `.agent-policy-live` sits above policy cards and shows the latest AI action, decision tick, and short intent as a compact realtime feed.

### Invite Strip
- **Structure**: one compact unframed control group in the room panel, using token text, status text, copy, command-copy, create, revoke buttons, a monospace command preview, and a short ordered help block.
- **Variants**: idle, pending, active token, error, non-participant disabled.
- **Spacing**: 8-12px gaps; controls wrap below 560px.
- **Accessibility**: the room panel exposes one copy action only: a full runnable command for coding-session intake; visible token and command preview are redacted.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 100-150ms | ease-out | Button hover/active, selected changes |
| Standard | 200-300ms | ease-in-out | Panel and status state changes |
| Emphasis | 450ms | cubic-bezier(0.18, 1.4, 0.4, 1) | Victory overlay pop-in |

### Rules

- Animate transform, opacity, filter, and color changes only.
- Preserve existing tactile button motion.
- Respect compact game readability over decorative motion.

## 7. Depth & Surface

### Strategy

Depth strategy is mixed but consistent with the current app: glass panels for lobby/room flow, darker bordered wells for game UI, and canvas-drawn arcade depth in-game.

| Level | Value | Usage |
|-------|-------|-------|
| Glass | blur(10px), translucent white, 1px white border | Login, lobby, room panel |
| Game panel | blue vertical gradient, 2px blue border, 14px radius | Sidebar, guide, bottom bar |
| Game well | #060e2e, blue border, 10px radius | Timer, item slot, stat slots |
| Broad shadow | 0 12px 40px rgba(0, 0, 0, 0.3-0.4) | Panels, canvas, sidebar |

### Radius Baseline

- Large glass panel: 20px.
- Guide and sidebar: 14px.
- Canvas and bottom bar: 12px.
- Inputs, buttons, room items, player slots, timer wells: 10px.
- Small badges: 6px.
- Item tokens and compact icon tiles: 8-9px.
