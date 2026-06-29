# Agent Heuristics

This document is for external agents that connect through the Agent API and want to
create, tune, and execute their own game heuristics. The server remains the
authoritative simulator and action envelope; the agent owns policy generation.

## Positioning

Do not treat this as a fixed bot script. Treat it as a policy workbench:

1. Keep a long-lived event loop open and continuously consume `agentStatus`.
2. If `agentStatus.canAct` is false, follow `nextExpectedAction` and keep waiting.
3. When `agentObservation.status.canAct` is true, observe `agentObservation.state`.
4. Derive tactical features such as danger, reachable cells, item value, escape routes,
   and opponent trap windows.
5. Generate or select heuristic cards.
6. Veto unsafe actions.
7. Execute one bounded `agentAction`.
8. Record the result and revise the cards.

This matches the direction of the referenced `poke-pi` harness: the agent can synthesize
constrained policy artifacts, while the harness validates and executes only safe controller
actions.

Executable baseline:

```bash
CRAZAY_ARKADE_AGENT_TOKEN="<invite-token>" node examples/llm-reply-agent.js --url http://localhost:3000
```

The baseline implementation lives in `lib/agent/heuristics.js`. It intentionally stays
agent-side: the server still accepts only `agentAction`, while this module builds
danger maps, reachability maps, bomb lookahead, item routing, and simple route
commitment from observations.

For onboarding, the minimum correct shape is an infinite event loop, not a one-shot
status check. `agentStatus` is the control plane: it says whether the agent should wait
for game start, wait for countdown, create/join a room, reconnect, stop, or act.
`agentObservation` is the data plane: use it to build heuristics only when
`observation.status.canAct === true`.

The room UI exposes baseline cards before a live update arrives, then switches to
runtime cards published by the attached agent during gameplay. Use it as a quick
operator view: **집행** cards are hard envelopes or vetoes, and **생성** cards are
candidate heuristics the reference agent creates or selects from the current
observation. The UI also calls out that `--max-actions` is just the example client's
local debug/test exit budget, not a server policy.

## Research Summary

The useful prior from Bomberman/Pommerman research is not "attack first"; it is
"survive first, then optimize pressure." The practical control unit is a short
action sequence, also called an option: choose a baseline objective, commit to its route
for a few ticks, and interrupt only when danger, blockage, or target invalidation makes
the sequence stale.

- Crazay Arkade exposes a compact action surface: movement, bomb placement, and item use.
  That maps directly to this project's `move`, `placeBomb`, `useNeedle`, `selectItem`,
  and `useItem` actions.
- Pommerman-like environments are hard because bombs are delayed, chainable, and lethal,
  while rewards are sparse and opponents are not fully predictable.
- The default Pommerman `SimpleAgent` baseline collects power-ups, places bombs near
  opponents, avoids blasts, and uses Dijkstra-style pathfinding on every step.
- BorealisAI's Pommerman action filter prunes actions that lead to death by comparing
  how soon a cell can be escaped with how soon nearby bombs explode. Its bomb lookahead
  rejects placing a bomb if the resulting state leaves no safe action.
- Winning and high-ranking Bomberman agents often use fast search, but they still lean
  on survivability checks, first-move pruning, opponent prediction, and hand-shaped state
  evaluation.
- Random exploration is especially bad in this genre: after placing a bomb in a corridor,
  the survival path can be a single exact sequence.
- Open-source Bomberman baselines commonly keep queued moves, run BFS/Dijkstra routes,
  reject bombs without a safe escape route, and use loop breakers or WAIT penalties.
- Player strategy guides for Bomberman and Crazy Arcade agree on the same baseline:
  farm items early, bomb only with an exit, pinch opponents by removing escape lanes,
  and treat trapped/bubbled players as provisional if a needle or rescue is possible.

Sources:

- Nexon 원작 가이드: https://ca.nexon.com/Info/Guide/1/3
- Pommerman playground paper: https://ceur-ws.org/Vol-2282/MARLO_104.pdf
- RBC Borealis Pommerman notes: https://rbcborealis.com/research-blogs/pommerman-team-competition-or-how-we-learned-stop-worrying-and-love-battle/
- BorealisAI action pruning: https://github.com/BorealisAI/pommerman-baseline
- Winning Pommerman with pessimistic scenarios: https://proceedings.mlr.press/v101/osogami19a/osogami19a.pdf
- Safe RL with shallow MCTS in Pommerman: https://ala2019.vub.ac.be/papers/ALA2019_paper_26.pdf
- Successful Hypersonic/Bomberman agent: https://www.scitepress.org/Papers/2022/108402/108402.pdf
- User-referenced policy synthesis pattern: https://github.com/IYEN-AI/poke-pi
- Sequence-oriented Bomberman AI queue: https://github.com/baines/bomberman-ai/blob/9524e9a0d8aea18f15107500678edd54c601ed82/AI.java#L29-L110
- Bomberland simple agent proposal stack: https://github.com/CoderOneHQ/bomberland/blob/75fb0d6b0b3c6ebc2350d8d9d6d0218cc8de2672/agent_code/simple_agent/callbacks.py#L10-L205
- GameDev safe bomb placement note: https://gamedev.stackexchange.com/questions/25349/giving-a-bomberman-ai-intelligent-bomb-placement
- Crazy Arcade item reference: https://crazyarcade.fandom.com/wiki/Item_%28PopTag%21%29

## State Primitives

Current snapshots expose enough data for rule, search, and hybrid agents:

- `state.grid`: `15 x 13` grid. `0` empty, `1` soft block, `2` hard block.
- `state.players`: player positions, team, alive/trapped state, power, max bomb count,
  speed, inventory, shield/oxygen timers, and `controller`.
- `state.bombs`: bomb tile position, pixel position, remaining timer `t`, and pass-through
  players. Bomb owner is not currently exposed, so an agent that needs own active-bomb
  count should keep a conservative estimate from its own `placeBomb` attempts and later
  state changes.
- `state.streams`: active water blast cells.
- `state.items`: item tile positions and type.
- `state.hazards` / `state.telegraphs`: map and boss danger cues.
- `state.boss` / `state.minions`: PvE-specific targets and threats.
- `state.tick`, `state.countdown`, `state.timeLeft`: timing context.

Useful constants from the simulator:

- Board: `15 x 13` cells.
- Tile: `40px`.
- Tick rate: `30 Hz`.
- Bomb fuse: `90` ticks.
- Water stream duration: `18` ticks.
- Bubble trap duration: `180` ticks.

## Heuristic Card Shape

Agents should store heuristics as data, not arbitrary code, when the goal is self-tuning
or agent-created policy.

```json
{
  "id": "safe-bomb-soft-block-v1",
  "intent": "farm",
  "priority": 40,
  "when": [
    "self.alive",
    "ownActiveBombEstimate < self.maxBombs",
    "adjacentSoftBlockCount >= 1"
  ],
  "score": [
    { "feature": "softBlocksHit", "weight": 3.0 },
    { "feature": "nearestSafeCellDistance", "weight": -2.0 },
    { "feature": "enemyThreatNearby", "weight": -1.5 }
  ],
  "action": { "type": "placeBomb" },
  "veto": [
    "noSafeEscapeAfterBomb",
    "currentTileExplodesBeforeExit",
    "wouldTrapSelfInCorridor"
  ],
  "telemetry": ["bombPlaced", "softBlocksBroken", "escapedAfterOwnBomb"]
}
```

Recommended priority bands:

- `1000+`: hard safety vetoes.
- `800`: trapped/needle/oxygen rescue.
- `700`: immediate escape from blast, stream, hazard, or boss telegraph.
- `500`: guaranteed kill or teammate rescue.
- `300`: high-value item pickup when safe.
- `200`: farming soft blocks and improving position.
- `100`: low-risk pressure and enemy zoning.
- `0`: wait or continue current route.

## Core Feature Builders

### Future Danger Map

Build a map from cell to earliest dangerous tick:

1. Mark active `streams` as dangerous now.
2. For each bomb, raycast up/down/left/right until hard block, soft block, or board edge.
3. Use bomb timer `t` as the danger tick.
4. If one bomb is in another bomb's blast line, reduce the later bomb's danger time to the
   earlier chain time.
5. Add map hazards, boss telegraphs, and boss/minion contact danger.

Output:

```js
{
  dangerAt: Map<"x,y", tick>,
  lethalNow: Set<"x,y">,
  source: Map<"x,y", "bomb" | "stream" | "hazard" | "boss">
}
```

### Reachability Map

Run BFS from the agent's current tile. Track both distance and first move:

- Reject hard/soft blocks.
- Reject bombs unless the current bomb's `pass` list contains this player and movement is
  leaving the bomb cell.
- Penalize cells whose `dangerAt <= distance + safetyMargin`.
- Keep `firstMove` for action selection.

Output:

```js
{
  reachable: Map<"x,y", { dist, firstMove, safe }>,
  nearestSafe: { x, y, dist, firstMove } | null
}
```

### Bomb Lookahead

Before `placeBomb`, simulate adding one bomb at self tile:

- Timer: `90` ticks.
- Power: `self.power`.
- Passable: self can leave its own bomb cell, but cannot re-enter after fully exiting.
- Recompute danger and reachability.

Veto if no safe cell is reachable before the new blast.

## Example Heuristics

### H001: Unsafe Action Pruner

Intent: reject actions before ranking.

Logic:

- For each candidate move, estimate the next tile.
- Reject if the destination is lethal now.
- Reject if `dangerAt(destination) <= stepsToEscape(destination) + margin`.
- Reject `placeBomb` if bomb lookahead has no safe exit.

This is the most important card. It should run before attack, farming, or item pickup.

### H002: Immediate Escape

Intent: leave an active or soon-to-explode danger cell.

Trigger:

- Self tile is in `lethalNow`, or `dangerAt(selfTile) <= escapeUrgencyTicks`.

Action:

- Move along BFS path to nearest safe cell.
- Prefer a cell that remains safe for at least `18` ticks after arrival.
- Use `shield` only if no safe path exists and shield is available.

### H003: Bubble Rescue

Intent: escape or rescue trapped players.

Trigger:

- `self.trapped` is true.
- Teammate is trapped and reachable before enemy contact or trap timeout.

Action:

- If self trapped and `needles > 0`, emit `useNeedle`.
- If self trapped and oxygen exists, emit `useItem` with `oxygen` when needle is absent.
- If teammate trapped, path to teammate only when route is safe and not worse than the
  team's current threat.

### H004: Safe Soft-Block Farm

Intent: open the map and reveal items.

Trigger:

- Adjacent or blast-line soft block exists.
- No higher-priority escape/rescue/attack applies.

Score:

- `+3` per soft block hit by the bomb.
- `+2` if the bomb opens a corridor toward center or enemy side.
- `-2` per tick needed to reach safety.
- `-5` if the safe route is a single-cell corridor with no branch.

Action:

- `placeBomb`, then commit to the selected escape route for several ticks.

### H005: Safe Item Pickup

Intent: collect items only when the path is survivable.

Priority:

- Early game: `bomb`, `power`, `speed`.
- Mid game: `needle`, `shield`, `shoes`, `glove`.
- Boss mode: `shield`, `oxygen`, `angel`, then stat items.

Veto:

- Path crosses a cell dangerous before arrival.
- Item is inside an opponent's likely trap window.
- Pickup causes self to miss an urgent escape deadline.

### H006: Line Trap Attack

Intent: place a bomb when the opponent has fewer safe exits than self.

Trigger:

- Opponent is in same row or column within `self.power`, or can be forced into that line.
- Opponent's reachable safe cells after the bomb are below threshold.
- Self has at least one safe route after the bomb.

Score:

- `+8` if opponent has zero safe exits.
- `+4` if bomb blocks a chokepoint.
- `+2` if a chain reaction shortens the opponent's timer.
- `-6` if teammate is in blast route.

### H007: Chokepoint Zoning

Intent: deny space, not necessarily kill immediately.

Trigger:

- A bomb would split the board or block a narrow corridor.
- Self can retreat to a safe region with more reachable cells than the opponent.

Action:

- Place bomb, retreat, then hold a safe tile that keeps pressure.

### H008: Anti-Oscillation Commitment

Intent: avoid left-right or up-down indecision.

Logic:

- Keep the current route for `4-8` ticks while it remains safe.
- Break commitment immediately if danger appears earlier than the route's safety margin.
- Penalize reversing the previous move unless reversal is the only safe action.

### H009: Opponent Prediction Lite

Intent: avoid planning as if opponents stand still.

Logic:

- For each opponent, compute their safe reachable cells in `N` ticks.
- Treat cells reachable by both self and opponent as contested.
- When attacking, prefer bombs that remain good if the opponent takes their best escape
  route, not only their current tile.

This is cheaper than full MCTS and matches the opponent-prediction idea used by stronger
Bomberman agents.

### H010: Team Safety

Intent: prevent friendly fire and enable rescue.

Veto:

- Do not place a bomb if a teammate has no safe route after the bomb.
- Do not chase an enemy through a teammate's bubble rescue path.
- In team mode, prefer pressure that narrows enemy exits without narrowing teammate exits.

### H011: Boss Telegraph Dodge

Intent: prioritize PvE survival.

Trigger:

- `state.telegraphs` marks cells near self.
- Boss is charging or minions are close.

Action:

- Move to nearest cell outside telegraph and contact range.
- Prefer cells with a line to punish boss after the splash.

### H012: Boss Groggy Punish

Intent: convert boss vulnerable windows into damage.

Trigger:

- `state.boss.groggy` is true.
- Self has a safe exit after bombing.

Action:

- Move to a blast line near the boss.
- Place bomb only if the self-exit veto passes.

## Action Selection Loop

```js
function chooseAction(observation, memory) {
  const state = observation.state;
  const self = observation.self;
  const features = buildFeatures(state, self, memory);

  const candidates = [
    move("up"),
    move("down"),
    move("left"),
    move("right"),
    { type: "placeBomb" },
    { type: "useItem" },
    { type: "wait" }
  ];

  const safe = pruneUnsafe(candidates, features);
  const scored = scoreWithHeuristicCards(safe, features, memory.cards);
  const action = breakTies(scored, memory.currentRoute);

  memory.lastAction = action;
  memory.currentRoute = updateCommitment(action, features, memory);
  return action;
}
```

## Agent-Created Heuristic Workflow

The agent should create heuristics through measured iterations:

1. Scout: run a conservative card set for several games.
2. Evaluate: summarize deaths, self-bombs, failed escapes, items collected, boxes broken,
   enemies trapped, teammate saves, and boss damage.
3. Propose: create one new card or weight change.
4. Validate: reject cards that bypass hard vetoes or use fields not present in state.
5. Playtest: run the candidate against the same baseline scenario.
6. Promote: keep the card only if it improves the target metric without increasing
   self-death or teammate-death rate.

Suggested generated-policy envelope:

```json
{
  "schema": "crazay-arkade-agent-policy.v1",
  "objective": "survive-then-pressure",
  "constants": {
    "safetyMarginTicks": 6,
    "routeCommitTicks": 6,
    "escapeUrgencyTicks": 24
  },
  "cards": [
    "unsafe-action-pruner-v1",
    "immediate-escape-v1",
    "safe-soft-block-farm-v1",
    "line-trap-attack-v1"
  ],
  "weights": {
    "survival": 1000,
    "teammateSafety": 900,
    "guaranteedKill": 500,
    "itemValue": 150,
    "softBlockFarm": 80,
    "centerAccess": 20
  }
}
```

## Runtime Policy Updates

The reference agent now turns its live decision branch into inspectable cards. On each
`agentObservation`, it chooses an action, snapshots the current runtime policy, and emits
`agentPolicyUpdate` when the policy revision changes. The server sanitizes that payload
and relays it to the room, where the in-game policy panel shows the latest generated
cards instead of the static baseline.

LLM-driven agents should use the same surface differently: continuously store the
freshest `agentObservation`, then select which heuristic to execute when an LLM reply
arrives. That reply arrival tick is reported as `decisionTick`, with
`decisionSource: "llm-reply"`, `selectedHeuristicId`, and an optional `llmReplyId`.
The server still executes no model code; it only relays the resulting bounded
`agentAction` and the policy cards that explain that reply's heuristic selection.

Use schema `crazay-arkade-agent-runtime-policy.v2` for this live surface. The server
still accepts the older v1 shape for compatibility, but new agents should publish v2 so
the in-game panel can show the LLM-tick policy choice:

- `phase`: `survive`, `farm`, `contest`, `recover`, or `endgame`.
- `intent`: the specific reason this heuristic is being executed now.
- `selectedHeuristicId`: the active heuristic, such as `survival-veto` or `item-value`.
- `fallbackHeuristicId`: the bounded fallback when the selected heuristic is invalid.
- `risk`, `confidence`, `expectedHorizonTicks`, and `constraints`: operator-readable
  guardrails for the choice.
- `actionMask`: copy `observation.valid_actions` so the policy explains what the server
  would currently accept.
- `benchmark`: short current metrics such as legality, recovery, naturalism, or policy
  accuracy.

Keep cards small and descriptive:

- `kind: "enforce"` for safety envelopes, vetoes, and recovery constraints.
- `kind: "create"` for generated routes, item targets, bomb escape plans, fallback moves,
  or newly proposed scoring heuristics.
- `signals` should name the observed features that caused the card to exist.
- `actions` should name the bounded action or commitment the agent will send through
  `agentAction`.

The current baseline emits cards such as `runtime-escape-route`,
`runtime-item-route`, `runtime-bomb-escape`, and `runtime-safe-fallback`. External agents
can add their own generated cards, but should keep the same rule: generated policy is
telemetry and operator evidence, while actual control still happens only through bounded
`agentAction`.

The LLM should not decide raw movement every tick. It should reply whenever your agent
asks for policy guidance; that reply chooses the heuristic to execute, revise, or create.
Between LLM replies, local deterministic heuristics execute against the latest
`agentObservation.valid_actions` and safety maps. This keeps movement human-paced while
letting the model steer policy at meaningful decision points.

The current sequence executor publishes baseline plan metadata for the active route:

- `kind`: `survival-escape`, `bomb-escape`, `item-route`, `opponent-pressure`, or
  `safe-fallback`.
- `objective`: `reach_safe_cell`, `escape_after_bomb`, `collect_item`,
  `cut_escape_lane`, or `avoid_stall`.
- `target`: the item, opponent, or safe cell the route is moving toward.
- `interrupts`: danger threshold, invalid target, or blocked path.

LLM replies may select these bounded heuristic IDs:

- `survival-veto`: override into recovery or nearest safe cell.
- `route-commit`: continue an existing route while still safe.
- `item-value`: route to the highest-value safe item.
- `safe-bomb-farm`: place a bomb only after the self-exit check, then execute the escape
  sequence.
- `pressure-trap`: move beside a live opponent's escape lanes to prepare a pinch without
  raw bomb spam.
- `fallback-move`: anti-stall safe movement toward useful central or soft-block-adjacent
  cells.

Benchmark the policy loop with `createBenchmarkTracker()` from `lib/agent/benchmark.js`.
Use the five default tracks when comparing generated heuristics:

- Legality: accepted/rejected action ratio and fallback use.
- Recovery: reconnects, resume success, and trapped recovery.
- Naturalism: reaction-time samples in the human-plausible band.
- Policy: expected vs selected heuristic agreement in scripted situations.
- Generalization: distinct maps/seeds/scenarios exercised.

## Anti-Priors

Avoid these policies unless a later experiment proves them useful:

- Bombing every time it seems locally safe. Search-based Bomberman agents can develop
  this bad habit and still get trapped later.
- Chasing an item through a soon-dangerous route.
- Treating opponent current position as fixed.
- Using a shallow search horizon that cannot see the bomb fuse.
- Learning only against one exploitable scripted opponent.
- Creating arbitrary code policies. Use constrained heuristic cards so generated policies
  remain inspectable and enforceable.

## Minimal Baseline Order

Start with this card order:

1. `Unsafe Action Pruner`
2. `Immediate Escape`
3. `Bubble Rescue`
4. `Safe Item Pickup`
5. `Safe Soft-Block Farm`
6. `Opponent Pressure Trap`
7. `Anti-Oscillation Commitment`
8. `wait`

Once this baseline survives consistently, let the agent generate variants around item
weights, trap thresholds, opponent prediction horizon, and boss-specific cards.
