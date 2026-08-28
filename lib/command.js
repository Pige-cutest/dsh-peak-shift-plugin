/**
 * @module dsh-peak-shift/command
 * Human-facing `/peak-shift` slash command: view or flip the master switch.
 * The command only reads/writes the controller; the settings namespace owns
 * persistence and hot-reload.
 */

const USAGE = "Usage: /peak-shift [on|off|status]";

/** Register the `/peak-shift` command once the command service is available. */
export function registerPeakShiftCommand(ctx, controller) {
  ctx.inject(['commands'], (sctx) => {
    sctx.commands.register({
      name: 'peak-shift',
      description: 'view or toggle the peak-shift token saver',
      input: { hint: '[on|off|status]' },
      handler: (invocation) => executePeakShiftCommand(invocation, controller),
    });
  });
}

/** Execute one parsed human command through the controller. */
async function executePeakShiftCommand(invocation, controller) {
  const input = invocation.rawInput.trim();
  const control = input.toLowerCase();
  if (control === 'on' || control === 'enable') {
    await controller.setEnabled(true);
    return {
      kind: 'success',
      text: `peak-shift enabled.\n${statusText(controller)}`,
    };
  }
  if (control === 'off' || control === 'disable') {
    await controller.setEnabled(false);
    return {
      kind: 'success',
      text: `peak-shift disabled.\n${statusText(controller)}`,
    };
  }
  if (control !== '' && control !== 'status') {
    return {
      kind: 'error',
      text: `Unknown argument ${JSON.stringify(input)}.\n${USAGE}`,
    };
  }
  return {
    kind: 'success',
    text: statusText(controller),
  };
}

function statusText(controller) {
  return `peak-shift: ${controller.isEnabled() ? 'enabled' : 'disabled'}\n${USAGE}`;
}
