import { normalizeTanzanianPhone } from '@/common/phone';

describe('normalizeTanzanianPhone', () => {
  it.each([
    ['0712345678', '255712345678'],
    ['0623470541', '255623470541'],
    ['255623798302', '255623798302'],
    ['+255 712 345 678', '255712345678'],
    ['+255-712-345-678', '255712345678'],
    ['(0712) 345 678', '255712345678'],
    // Already national without the trunk zero.
    ['712345678', '255712345678'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeTanzanianPhone(raw)).toEqual({ ok: true, value: expected });
  });

  it('never doubles the country code', () => {
    // `0712…` is `255712…`, not `2550712…` — the trunk zero is replaced.
    const result = normalizeTanzanianPhone('0712345678');

    expect(result).toEqual({ ok: true, value: '255712345678' });
  });

  it.each([
    ['', 'no phone number on record'],
    ['   ', 'no phone number on record'],
    // A real row in jarvis: nine digits, but no Tanzanian mobile starts with 4.
    ['476978247', 'not a Tanzanian mobile number'],
    ['12345', 'not a Tanzanian mobile number'],
    ['255812345678', 'not a Tanzanian mobile number'],
    ['not a phone', 'not a Tanzanian mobile number'],
  ])('refuses %s', (raw, reason) => {
    const result = normalizeTanzanianPhone(raw);

    expect(result.ok).toBe(false);
    // The reason is stored on the reminder row, so it has to say what was wrong.
    expect(result.ok === false && result.reason).toContain(reason);
  });

  it('treats null and undefined as no number rather than throwing', () => {
    expect(normalizeTanzanianPhone(null).ok).toBe(false);
    expect(normalizeTanzanianPhone(undefined).ok).toBe(false);
  });
});
