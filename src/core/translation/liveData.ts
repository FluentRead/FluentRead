/**
 * @file src/core/translation/liveData.ts
 * 文件职责：识别页面中无需翻译的独立数值、日期、时钟和时长展示。
 * 主要内容：按完整文本匹配数字、带时区的时钟、组合日期及中英文时长（含繁体与带点缩写），保留含时间或数字的完整句子。
 * 模块边界：纯文本判定，不读取 DOM、配置或时间，不创建监听器，也不影响主动划词翻译。
 */

const number = String.raw`[+-]?\p{Nd}+(?:[.,\s]\p{Nd}+)*`;
const unit = String.raw`(?:milliseconds?|msecs?\.?|ms|seconds?|secs?\.?|s|minutes?|mins?\.?|m|hours?|hrs?\.?|h|days?|d|毫秒|秒[钟鐘]?|分[钟鐘鍾]?|小[时時]|[时時]|天)`;
const duration = new RegExp(String.raw`^(?:in\s+)?(?:${number}\s*${unit}\s*[,，]?\s*)+(?:ago|前|后|後)?$`, 'iu');
const numeric = new RegExp(String.raw`^[\p{Sc}]?\s*${number}\s*(?:[%‰]|[kmb])?$`, 'iu');
const meridiem = String.raw`(?:a\.?m\.?|p\.?m\.?)`;
const localizedMeridiem = String.raw`(?:上午|下午|凌晨|早上|晚上|中午)`;
const zone = String.raw`(?:z|(?:utc|gmt)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2}|[pmce][sd]t)`;
const colonClock = String.raw`(?:${meridiem}\s*|${localizedMeridiem}\s*)?\d{1,3}\s*:\s*[0-5]\d(?:\s*:\s*[0-5]\d)?(?:[.,]\d+)?(?:\s*${meridiem})?`;
const clockValue = String.raw`(?:${colonClock}|(?:1[0-2]|[1-9])\s*${meridiem}|${meridiem}\s*(?:1[0-2]|[1-9]))(?:\s*${zone})?`;
const clock = new RegExp(String.raw`^${clockValue}$`, 'iu');
const numericDateValue = String.raw`\d{4}[-/]\d{1,2}[-/]\d{1,2}`;
const dateTime = new RegExp(String.raw`^${numericDateValue}(?:[t\s]+${clockValue})?$`, 'iu');
const localizedDateValue = String.raw`(?:\d{4}年)?\d{1,2}月\d{1,2}日`;
const localizedClockValue = String.raw`(?:${localizedMeridiem}\s*)?\d{1,2}(?:时|時|点|點)\d{1,2}分(?:\d{1,2}秒)?`;
const localizedClock = new RegExp(String.raw`^${localizedClockValue}$`, 'u');
const localizedDate = new RegExp(String.raw`^${localizedDateValue}(?:\s*(?:${localizedClockValue}|${clockValue}))?$`, 'iu');
const socialDate = String.raw`(?:${localizedDateValue}|${numericDateValue})`;
// 仅跳过完整日期展示，不据年/月/日这类共享汉字推断正文语言。
const localizedTimestamp = new RegExp(String.raw`^(?:${clockValue}\s*·\s*${socialDate}|${socialDate}\s*·\s*${clockValue})$`, 'iu');

/** 仅匹配整个展示值；“The task takes 5 minutes” 等正文继续翻译。 */
export function isNonTranslatableLiveData(value: string): boolean {
    const text = value.normalize('NFKC').replace(/[\s\u3000]+/gu, ' ').trim();
    return text !== '' && text.length <= 128 && (numeric.test(text) || clock.test(text) || dateTime.test(text) ||
        localizedClock.test(text) || localizedDate.test(text) || localizedTimestamp.test(text) || duration.test(text));
}
