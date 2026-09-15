import { booleanEnv } from '@/config/env';

describe('booleanEnv', () => {
  const NAME = 'BOOLEAN_ENV_SPEC';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('uses the default when unset', () => {
    expect(booleanEnv(NAME, false)).toBe(false);
    expect(booleanEnv(NAME, true)).toBe(true);
  });

  it('uses the default when blank, which is how .env.example ships', () => {
    process.env[NAME] = '';
    expect(booleanEnv(NAME, false)).toBe(false);

    process.env[NAME] = '   ';
    expect(booleanEnv(NAME, true)).toBe(true);
  });

  it('accepts true and false in any case', () => {
    process.env[NAME] = 'TRUE';
    expect(booleanEnv(NAME, false)).toBe(true);

    process.env[NAME] = ' False ';
    expect(booleanEnv(NAME, true)).toBe(false);
  });

  it('throws on anything else, naming the variable', () => {
    process.env[NAME] = 'flase';
    expect(() => booleanEnv(NAME, false)).toThrow(
      'BOOLEAN_ENV_SPEC must be "true" or "false"',
    );
  });
});
