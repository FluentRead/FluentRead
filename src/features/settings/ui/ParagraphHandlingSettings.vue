<!--
 * @file src/features/settings/ui/ParagraphHandlingSettings.vue
 * 文件职责：在高级选项中集中呈现段落级翻译设置，包括参与翻译的最少字符数、免滚动预翻译字符数、长段落换行与译文位置。
 * 主要内容：把四项配置绑定到共享 config 对象，数值输入在变更时按公共范围函数归一化，开关直接写回布尔字段，说明文案全部走稳定 message key。
 * 模块边界：本组件只做绑定与取值约束，不自行持久化、不决定候选发现算法，也不渲染网页译文；阈值语义由 core 配置模块统一提供。
 -->
<template>
  <SettingsGroup :title="t('settings.paragraph.title')" :description="t('settings.paragraph.description')">
    <SettingsItem :label="t('settings.paragraph.minLength')" :description="t('settings.paragraph.minLengthDescription')">
      <div class="paragraph-number-field">
        <el-input-number
          v-model="props.config.minTranslationTextLength"
          :aria-label="t('settings.paragraph.minLength')"
          :min="MIN_TRANSLATION_TEXT_LENGTH_MIN"
          :max="MIN_TRANSLATION_TEXT_LENGTH_MAX"
          :step="1"
          controls-position="right"
          @change="changeMinLength"
        />
      </div>
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.eagerCharacters')" :description="t('settings.paragraph.eagerCharactersDescription')">
      <div class="paragraph-number-field">
        <el-input-number
          v-model="props.config.eagerTranslationCharacters"
          :aria-label="t('settings.paragraph.eagerCharacters')"
          :min="EAGER_TRANSLATION_CHARACTERS_MIN"
          :max="EAGER_TRANSLATION_CHARACTERS_MAX"
          :step="100"
          controls-position="right"
          @change="changeEagerCharacters"
        />
      </div>
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.lineBreak')" :description="t('settings.paragraph.lineBreakDescription')">
      <el-switch v-model="props.config.longParagraphLineBreakEnabled" class="settings-toggle"
        :aria-label="t('settings.paragraph.lineBreak')" />
    </SettingsItem>
    <SettingsItem :label="t('settings.paragraph.translationFirst')" :description="t('settings.paragraph.translationFirstDescription')">
      <el-switch v-model="props.config.translationBeforeOriginal" class="settings-toggle"
        :aria-label="t('settings.paragraph.translationFirst')" />
    </SettingsItem>
  </SettingsGroup>
</template>

<script lang="ts" setup>
import type {Config} from '@/src/core/config/model';
import {
  EAGER_TRANSLATION_CHARACTERS_MAX,
  EAGER_TRANSLATION_CHARACTERS_MIN,
  MIN_TRANSLATION_TEXT_LENGTH_MAX,
  MIN_TRANSLATION_TEXT_LENGTH_MIN,
  normalizeEagerTranslationCharacters,
  normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';

const props = defineProps<{config: Config}>();
const {t} = useUiI18n();

const changeMinLength = (value: number | undefined): void => {
  props.config.minTranslationTextLength = normalizeMinTranslationTextLength(value);
};

const changeEagerCharacters = (value: number | undefined): void => {
  props.config.eagerTranslationCharacters = normalizeEagerTranslationCharacters(value);
};
</script>

<style scoped>
.paragraph-number-field {
  width: min(100%, 184px);
  min-width: 0;
}

.paragraph-number-field :deep(.el-input-number) {
  width: 100%;
  min-width: 0;
}

.paragraph-number-field :deep(.el-input-number .el-input__inner) {
  text-align: right;
}
</style>
