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

/**
 * Reads a comma-separated list of whole numbers, zero or greater — `24,1`.
 *
 * Blank or unset takes the default, for the same reason as `booleanEnv`. Every
 * entry must be digits only, so `24,,1`, `24;1`, `-1` and `1.5` all throw at
 * boot rather than being dropped: `Number('')` is `0` and `parseInt('1.5')` is
 * `1`, and either would quietly configure a period nobody asked for.
 *
 * Order and duplicates are returned as written; what they mean is up to the
 * caller.
 */
export function integerListEnv(name: string, defaultValue: number[]): number[] {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  return raw.split(',').map((entry) => {
    const value = entry.trim();
    if (!/^\d+$/.test(value)) {
      throw new Error(
        `${name} must be comma-separated whole numbers like "24,1" ` +
          `(or left blank for "${defaultValue.join(',')}"), got "${raw}"`,
      );
    }
    return Number(value);
  });
}
