/**
 * @file src/core/i18n/serviceLabels.ts
 * 文件职责：在已发布语言资源包之外提供新增服务目录文案的纯本地覆盖，保留脚本版固定远程资源地址。
 * 主要内容：维护 ChatGPT 套餐名称及接入说明的七语映射，只匹配明确登记的扩展自有文案，保留原始首尾空白，未登记文案交还通用旧文案适配器。
 * 模块边界：不加载资源包、不读取配置、不依赖 Vue 或 feature，也不翻译网页、用户模型编号、账号和正文；UI 层负责在通用翻译前消费此覆盖。
 */
import type {UiLanguage} from './types';

const sources = ['ChatGPT 套餐', '通过本机助手登录 ChatGPT，使用账户获准的套餐模型与额度。'] as const;
const labels: Readonly<Record<UiLanguage, readonly [string, string]>> = {
    'zh-CN': sources,
    'zh-TW': ['ChatGPT 方案', '透過本機助手登入 ChatGPT，使用帳戶核准的方案模型與額度。'],
    'en-US': ['ChatGPT Plan', 'Sign in to ChatGPT through the local helper and use the models and allowance authorized for your account.'],
    'ja-JP': ['ChatGPT プラン', 'ローカルヘルパーで ChatGPT にログインし、アカウントで許可されたプランのモデルと利用枠を使います。'],
    'ko-KR': ['ChatGPT 요금제', '로컬 도우미로 ChatGPT에 로그인하고 계정에 허용된 요금제 모델과 사용량을 이용합니다.'],
    'fr-FR': ['Abonnement ChatGPT', 'Connectez-vous à ChatGPT via l’assistant local pour utiliser les modèles et le quota autorisés pour votre compte.'],
    'ru-RU': ['Подписка ChatGPT', 'Войдите в ChatGPT через локальный помощник, чтобы использовать модели и лимиты, разрешённые для вашего аккаунта.'],
    'es-ES': ['Plan de ChatGPT', 'Inicia sesión en ChatGPT mediante el asistente local para utilizar los modelos y la cuota autorizados para tu cuenta.'],
};

/** 只覆盖登记的完整文本；函数替换保留译文内的美元符号及输入首尾空白。 */
export function translateServiceLabel(value: string, language: UiLanguage): string | undefined {
    const source = value.trim();
    const index = sources.indexOf(source as typeof sources[number]);
    if (index < 0) return undefined;
    return value.replace(source, () => labels[language][index]);
}
