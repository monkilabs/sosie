/** Real values planted in the test database. None may ever come out of Sosie. */
export const CANARIES = [
  'quill.vantablack@canary-mail.test',
  'Quillon Vantablack',
  'Vantablack',
  'Quillon',
  '+420 777 912 345',
  '777 912 345',
  'Vantaville',
  'sk_live_9Qv7Xc2Lm8Rt',
  'leave the parcel with Quillon',
  '7739182046',
  'd3adb33f-0000-4000-8000-c0ffee000001',
  'canary-mail',
  'Zephyrine Orrowmoor',
  'zephyrine@orrowmoor.test',
  'Orrowmoor',
] as const

/** Every canary found in a text, ignoring case. */
export function canariesIn(text: string): string[] {
  const lower = text.toLowerCase()
  return CANARIES.filter((c) => lower.includes(c.toLowerCase()))
}
