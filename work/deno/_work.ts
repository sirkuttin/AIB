/** Where the repo's work/ folder and the app are, and the Python that runs the fake agents the tests drive. */
export const WORK = new URL('../', import.meta.url);
export const APP = new URL('../outputs/agent-studio/', WORK);

export function python(): string {
  return Deno.env.get('AIB_PYTHON') ?? (Deno.build.os === 'windows' ? 'python' : 'python3');
}
