// 浏览器语言仅决定无明确语言前缀的首页；深链接保留原定语言，手动切换优先。
export const localeStorageKey = 'fluentread-site-language'
export function preferredLocale(saved, languages = []) {
  if (saved === 'zh-CN' || saved === 'en') return saved
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/i.test(language)) return 'en'
  }
  return 'en'
}
export function homeRedirect(pathname, search, hash, saved, languages) {
  if (pathname !== '/' && pathname !== '/index.html') return null
  return preferredLocale(saved, languages) === 'en'
    ? `/en/${search || ''}${hash || ''}`
    : null
}
// Runs before page paint; restricted storage must not prevent the page from loading.
export const localeBootstrap = `(()=>{try{let s;try{s=localStorage.getItem(${JSON.stringify(
  localeStorageKey
)})}catch{}const p=${preferredLocale.toString()};const r=${homeRedirect
  .toString()
  .replace(
    'preferredLocale(',
    'p('
  )};const target=r(location.pathname,location.search,location.hash,s,navigator.languages||[navigator.language]);if(target)location.replace(target)}catch{}})()`
export function rememberLanguageLink(event) {
  const link =
    event.target instanceof Element
      ? event.target.closest(
          '.VPNavBarTranslations a, .VPNavScreenTranslations a'
        )
      : null
  if (!link) return
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin) return
  try {
    localStorage.setItem(
      localeStorageKey,
      url.pathname.startsWith('/en/') ? 'en' : 'zh-CN'
    )
  } catch {}
}
