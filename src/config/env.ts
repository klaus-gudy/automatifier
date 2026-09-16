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
 * Reads a text setting, treating blank the same as unset.
 *
 * `process.env.X ?? 'default'` looks equivalent and is not: `??` falls back
 * only on `undefined`, so a `.env` shipping `X=` — which is exactly how
 * `.env.example` ships every key — yields an empty string that every caller
 * then treats as a real value. One of those empty strings is the AMQP default
 * exchange, which cannot be declared: the broker answers `ACCESS_REFUSED`, the
 * channel dies, and the process goes with it.
 */
export function stringEnv(name: string, defaultValue: string): string {
  return process.env[name]?.trim() || defaultValue;
}

/**
 * Reads a numeric setting, treating blank the same as unset and refusing
 * anything that is not a number.
 *
 * `Number(process.env.X ?? 10)` has the same blank problem with a worse
 * ending, because `Number('')` is `0` rather than `NaN` — a blank `PORT=`
 * binds a random port, a blank `RABBITMQ_PREFETCH=` means unlimited in-flight
 * messages, and both look like a setting that was honoured.
 */
export function numberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(
      `${name} must be a number (or left blank for ${defaultValue}), ` +
        `got "${raw}"`,
    );
  }

  return value;
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
