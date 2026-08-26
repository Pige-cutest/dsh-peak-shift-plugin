/**
 * @module dsh-peak-shift/goal
 * Thin wrappers over `ctx.goals` (dsh-goal), kept optional so the plugin
 * still works in a composition without the goal service.
 */

/** Read the live goal for an agent, or undefined when goals are absent. */
export function activeGoal(goals, agent) {
  if (!goals) return undefined;
  try {
    return goals.get(agent);
  } catch {
    return undefined;
  }
}

/**
 * Pause an active goal durably (`active → paused`, disarms the round driver).
 * Idempotent: does nothing when there is no active goal.
 */
export async function ensureGoalPaused(ctx, agent, goals) {
  const goal = activeGoal(goals, agent);
  if (!goal || goal.phase !== 'active') return false;
  goals.pause(agent, { id: goal.id, revision: goal.revision });
  await ctx.sessions.flush(agent.session);
  return true;
}

/**
 * Resume a paused goal durably (`paused → active`, re-arms the round driver).
 * Idempotent: does nothing when there is no paused goal.
 */
export async function resumePausedGoal(ctx, agent, goals) {
  const goal = activeGoal(goals, agent);
  if (!goal || goal.phase !== 'paused') return false;
  goals.resume(agent, { id: goal.id, revision: goal.revision });
  await ctx.sessions.flush(agent.session);
  return true;
}
