export function money(cents: number) {
  return (cents / 100).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
  })
}

export function parseMoney(value: string): number | null {
  const clean = value.trim().replace(',', '.')
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(clean)) return null
  const [whole, decimal = ''] = clean.split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function centsToField(cents: number): string {
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, '0')
  return whole + '.' + frac
}
