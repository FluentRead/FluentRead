import locales from './landing-locales.json'

export const landingLocales = Object.values(locales)
export type LandingLocale = (typeof landingLocales)[number]

export function getLandingLocale(relativePath: string): LandingLocale | undefined {
  return landingLocales.find((locale) => relativePath === locale.path.slice(1) + 'index.md')
}
