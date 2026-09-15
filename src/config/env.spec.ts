import { booleanEnv, integerListEnv } from '@/config/env';

describe('integerListEnv', () => {
  const NAME = 'INTEGER_LIST_ENV_SPEC';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('uses the default when unset or blank', () => {
    expect(integerListEnv(NAME, [24, 1])).toEqual([24, 1]);

    process.env[NAME] = '  ';
    expect(integerListEnv(NAME, [24, 1])).toEqual([24, 1]);
  });

  it('parses a comma-separated list, allowing spaces and zero', () => {
    process.env[NAME] = '30, 7 ,0';
    expect(integerListEnv(NAME, [])).toEqual([30, 7, 0]);
  });

  it.each(['24,,1', '24,', '24;1', '-1', '1.5', 'seven'])(
    'throws on "%s" instead of guessing',
    (value) => {
      process.env[NAME] = value;
      expect(() => integerListEnv(NAME, [24, 1])).toThrow(
        'INTEGER_LIST_ENV_SPEC must be comma-separated whole numbers',
      );
    },
  );
});

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
