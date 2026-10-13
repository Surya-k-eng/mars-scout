# Contract

The rules every module follows. Change this file only together with the backbone owner.

## Units and coordinates
- Distances: meters. Mass: kg. Time: seconds. Energy: Wh. Angles in code: radians.
- Grid: `heights[z * width + x]`, x grows east, z grows south (Three.js +z).
- World position of a grid cell: use `terrain.gridToWorld(gx, gz)`. Never do your own math.
- Terrain height in `terrain.heights` is in meters (placeholder terrain is fake).

## Events
| Event | Sent by | Payload | Used by |
|---|---|---|---|
| `phase:go` | anyone | phase name | PhaseManager |
| `phase:enter` / `phase:exit` | PhaseManager | phase name | all |
| `terrain:ready` | terrain | `{ width, height, cellSize, heights, heightAt, gridToWorld }` | most modules |
| `route:request` | ui | `{ start:{x,z}, goal:{x,z}, mode }` | pathfinding |
| `path:ready` | pathfinding | `{ mode, path:[{x,y,z}], stats }` | pathviz, ui |
| `path:failed` | pathfinding | `{ reason }` | ui |

Event names live in `src/core/events.js`. Use `EVENTS.X`, never raw strings.

## Phases
boot, menu, siteSelect, goalSelect, planning, flythrough, results

## Rules
1. Edit only your own `src/modules/<name>/` folder. `src/core/` belongs to the backbone owner.
2. Modules never import each other. Talk through the bus and `state`.
3. Camera moves go through `ctx.services.camera` (CameraDirector).
4. Pure logic (pathfinding, shadows, suitability) lives in plain functions with tests.
5. Big data files never go in git. See data-prep/README.md.