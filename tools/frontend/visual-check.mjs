import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir } from 'node:fs/promises'

await mkdir('artifacts', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const cases = [
  { name: 'home-desktop', path: '/', width: 1440, height: 900 },
  { name: 'home-mobile', path: '/', width: 390, height: 844 },
  { name: 'demo-desktop', path: '/demo', width: 1440, height: 900 },
  { name: 'demo-mobile', path: '/demo', width: 390, height: 844 },
  { name: 'customer-desktop', path: '/cliente', width: 1440, height: 900 },
]
for (const item of cases) {
  const context = await browser.newContext({ viewport: { width: item.width, height: item.height } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5173' + item.path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: 'artifacts/' + item.name + '.png', fullPage: true })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  console.log(JSON.stringify({
    case: item.name,
    title: await page.title(),
    overflow,
    errors,
    violations: result.violations.map(({ id, nodes }) => ({ id, count: nodes.length })),
  }))
  await context.close()
}
await browser.close()
