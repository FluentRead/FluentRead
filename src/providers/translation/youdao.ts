/**
 * @file src/providers/translation/youdao.ts
 *
 * 文件职责：适配有道智云翻译 API，生成 v3 签名并解析普通翻译及词典解释响应。
 * 主要内容：从配置快照读取应用凭据，按语言和时间戳构造 SHA-256 签名请求，通过 runtimeFetch 调用并根据 errorCode 返回 translation 或 basic.explains。 可核对的公开符号包括 default:youdao。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import { method } from "@/src/core/config/constants";
import { config } from "@/src/services/config/store";
import sha256 from 'crypto-js/sha256';
import {getTranslationLanguages} from '@/src/services/translation/languages';
import {createHttpStatusError, readJsonResponse} from '@/src/platform/http/errors';
import {runtimeFetch} from '@/src/platform/http/runtime';
import {
  getTranslationProviderConfig,
  type TranslationProviderRequest,
} from '@/src/services/translation/requestSnapshot';

interface YoudaoResponse {
  errorCode: string;
  translation: string[];
  basic?: {
    explains: string[];
  };
}

async function youdao(message: TranslationProviderRequest<string>): Promise<string> {
  const current = getTranslationProviderConfig(message, config);
  // 检查必需的配置
  if (!current.youdaoAppKey || !current.youdaoAppSecret) {
    throw new Error('请先配置有道翻译的 App Key 和 App Secret');
  }

  const appKey = current.youdaoAppKey;
  const appSecret = current.youdaoAppSecret;
  const query = message.origin;
  const salt = Date.now().toString();
  const curtime = Math.round(Date.now() / 1000).toString();

  // 生成签名
  function generateSign(appKey: string, query: string, salt: string, curtime: string, appSecret: string): string {
    let str1 = appKey + truncate(query) + salt + curtime + appSecret;
    return sha256(str1).toString();
  }

  // 截取函数（用于签名计算）
  function truncate(q: string): string {
    const len = q.length;
    if (len <= 20) return q;
    return q.substring(0, 10) + len + q.substring(len - 10, len);
  }

  // 语言代码映射
  const langMap: { [key: string]: string } = {
    'auto': 'auto',
    'zh-Hans': 'zh-CHS',
    'zh-Hant': 'zh-CHT',
    'en': 'en',
    'ja': 'ja',
    'ko': 'ko',
    'fr': 'fr',
    'es': 'es',
    'pt': 'pt',
    'it': 'it',
    'vi': 'vi',
    'de': 'de',
    'ar': 'ar',
    'id': 'id',
    'af': 'af',
    'bs': 'bs',
    'bg': 'bg',
    'ca': 'ca',
    'hr': 'hr',
    'cs': 'cs',
    'da': 'da',
    'nl': 'nl',
    'et': 'et',
    'fj': 'fj',
    'fi': 'fi',
    'el': 'el',
    'ht': 'ht',
    'he': 'he',
    'hi': 'hi',
    'mww': 'mww',
    'hu': 'hu',
    'sw': 'sw',
    'tlh': 'tlh',
    'lv': 'lv',
    'lt': 'lt',
    'ms': 'ms',
    'mt': 'mt',
    'no': 'no',
    'fa': 'fa',
    'pl': 'pl',
    'otq': 'otq',
    'ro': 'ro',
    'ru': 'ru',
    'sr-Cyrl': 'sr-Cyrl',
    'sr-Latn': 'sr-Latn',
    'sk': 'sk',
    'sl': 'sl',
    'sv': 'sv',
    'ty': 'ty',
    'th': 'th',
    'to': 'to',
    'tr': 'tr',
    'uk': 'uk',
    'ur': 'ur',
    'cy': 'cy',
    'yua': 'yua',
    'yue': 'yue'
  };

  const {sourceLanguage, targetLanguage} = getTranslationLanguages(message);
  const fromLang = langMap[normalizeChineseLanguageCode(sourceLanguage)] || sourceLanguage;
  const toLang = langMap[normalizeChineseLanguageCode(targetLanguage)] || targetLanguage;

  const sign = generateSign(appKey, query, salt, curtime, appSecret);

  // 构建请求参数
  const params = new URLSearchParams({
    q: query,
    from: fromLang,
    to: toLang,
    appKey: appKey,
    salt: salt,
    sign: sign,
    signType: 'v3',
    curtime: curtime
  });

  try {
    const response = await runtimeFetch('https://openapi.youdao.com/api', {
      method: method.POST,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: message.abortSignal,
    });

    if (!response.ok) {
      throw createHttpStatusError(response, '有道翻译请求失败');
    }

    const result = await readJsonResponse<YoudaoResponse>(response, '有道翻译返回的不是有效 JSON');

    // 处理错误码
    if (result.errorCode !== '0') {
      const errorMessages: { [key: string]: string } = {
        '101': '缺少必填的参数',
        '102': '不支持的语言类型',
        '103': '翻译文本过长',
        '104': '不支持的API类型',
        '105': '不支持的签名类型',
        '106': '不支持的响应类型',
        '107': '不支持的传输加密类型',
        '108': 'appKey无效',
        '109': 'batchLog格式不正确',
        '110': '无相关服务的有效实例',
        '111': '开发者账号无效',
        '113': 'q不能为空',
        '201': '解密失败',
        '202': '签名检验失败',
        '203': '访问IP地址不在可访问IP列表',
        '301': '辞典查询失败',
        '302': '翻译查询失败',
        '303': '服务端的其它异常',
        '401': '账户已经欠费',
        '411': '访问频率受限',
        '412': '长请求过于频繁'
      };
      
      const errorMsg = errorMessages[result.errorCode] || '未知错误';
      throw new Error(`有道翻译API错误: ${errorMsg}`);
    }

    // 返回翻译结果
    if (result.translation && result.translation.length > 0) {
      return result.translation.join(' ');
    } else {
      throw new Error('翻译结果为空');
    }

  } catch (error: any) {
    throw new Error(`翻译失败: ${error.message || error}`);
  }
}

export default youdao;
