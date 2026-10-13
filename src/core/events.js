// Every event name lives here. Never type event names as raw strings elsewhere.
export const EVENTS = {
  // app flow
  PHASE_GO: 'phase:go',
  PHASE_ENTER: 'phase:enter',
  PHASE_EXIT: 'phase:exit',

  // terrain
  TERRAIN_READY: 'terrain:ready',

  // picking
  SITE_PICK: 'site:pick',
  SITE_ACCEPTED: 'site:accepted',
  SITE_REJECTED: 'site:rejected',
  GOAL_PICK: 'goal:pick',

  // routing
  ROUTE_REQUEST: 'route:request',
  PATH_READY: 'path:ready',
  PATH_FAILED: 'path:failed',

  // sun
  TIME_SET: 'time:set',
  SUN_CHANGED: 'sun:changed',

  // camera / flythrough
  FLYTHROUGH_START: 'flythrough:start',
};