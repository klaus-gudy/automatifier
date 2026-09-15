/**
 * Reads a boolean environment variable, treating blank the same as unset.
 *
 * Exists because the obvious one-liners both fail on a real `.env`:
 *
 * - `process.env.X !== 'false'` turns `X=` — exactly how `.env.example` ships
 *   every key — into `true`. A blank line reads as "not configured", and
 *   silently enabling the feature is the opposite of what that means.
 * - `process.env.X === 'true'` turns a typo (`flase`, `ture`, `yes`) into
 *   `false` with no sign anything was mistyped.
 *
 * So blank or unset takes the stated default, `true`/`false` are accepted in
 * any case, and anything else throws. Called from `registerAs` factories, so
 * the throw happens at boot (and in the TypeORM CLI) naming the variable,
 * rather than as behaviour someone has to notice later.
 */
export function booleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  throw new Error(
    `${name} must be "true" or "false" (or left blank for ${defaultValue}), ` +
      `got "${process.env[name]}"`,
  );
}
